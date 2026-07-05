import { useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url'
import { createWorker } from 'tesseract.js'
import mammoth from 'mammoth/mammoth.browser'
import './App.css'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker

const MIN_TEXT_LENGTH_BEFORE_OCR = 3

function App() {
  const fileInputRef = useRef(null)

  const [selectedFile, setSelectedFile] = useState(null)
  const [slides, setSlides] = useState([])
  const [overallSummary, setOverallSummary] = useState(null)
  const [isLoading, setIsLoading] = useState(false)
  const [statusMessage, setStatusMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')

  function handleFileChange(event) {
    const file = event.target.files[0]

    if (!file) return

    const fileName = file.name.toLowerCase()
    const isPdf = fileName.endsWith('.pdf')
    const isDocx = fileName.endsWith('.docx')

    if (!isPdf && !isDocx) {
      alert('Please upload a PDF or DOCX file.')
      return
    }

    setSelectedFile(file)
    setSlides([])
    setOverallSummary(null)
    setErrorMessage('')
    setStatusMessage(isDocx ? 'DOCX selected. Ready to extract notes.' : 'PDF selected. Ready to extract notes.')
  }

  async function handleGenerateNotes() {
    if (!selectedFile) {
      alert('Please upload a PDF or DOCX first.')
      return
    }

    setIsLoading(true)
    setSlides([])
    setOverallSummary(null)
    setErrorMessage('')
    setStatusMessage('Reading file...')

    let ocrWorker = null

    try {
      const fileName = selectedFile.name.toLowerCase()
      const extractedSections = []

      if (fileName.endsWith('.docx')) {
        setStatusMessage('Reading DOCX file...')
        const text = await extractDocxText(selectedFile)
        const cleanText = cleanExtractedText(text)

        if (!cleanText.trim()) {
          throw new Error('DOCX file has no readable text.')
        }

        extractedSections.push(createSection({
          pageNumber: 1,
          rawText: text,
          cleanText,
          imageDataUrl: '',
          usedOCR: false,
          sourceType: 'docx',
        }))
      } else {
        setStatusMessage('Reading PDF...')
        const arrayBuffer = await selectedFile.arrayBuffer()
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise

        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
          setStatusMessage(`Extracting page ${pageNumber} of ${pdf.numPages}...`)

          const page = await pdf.getPage(pageNumber)
          const textItems = await extractPageTextItems(page)
          let rawText = formatTextItemsAsLines(textItems)
          const imageDataUrl = await renderPageAsImage(page)
          let usedOCR = false

          if (rawText.trim().length < MIN_TEXT_LENGTH_BEFORE_OCR) {
            setStatusMessage(`Page ${pageNumber} has no selectable text. Running OCR...`)

            if (!ocrWorker) {
              ocrWorker = await createWorker('eng')
            }

            const ocrImageDataUrl = await renderPageAsImage(page, 2.2)
            const { data } = await ocrWorker.recognize(ocrImageDataUrl)
            rawText = data.text || ''
            usedOCR = true
          }

          const cleanText = cleanExtractedText(rawText)

          extractedSections.push(createSection({
            pageNumber,
            rawText,
            cleanText,
            imageDataUrl,
            usedOCR,
            sourceType: 'pdf',
          }))
        }
      }

      setSlides(extractedSections)
      setOverallSummary(createOverallSummary(selectedFile.name, extractedSections))
      setStatusMessage('Done. Notes generated.')
    } catch (error) {
      console.error(error)
      setErrorMessage('Could not read this file. Try a PDF with selectable text or a real .docx file.')
      setStatusMessage('')
    } finally {
      if (ocrWorker) {
        await ocrWorker.terminate()
      }

      setIsLoading(false)
    }
  }

  function createSection({ pageNumber, rawText, cleanText, imageDataUrl, usedOCR, sourceType }) {
    const pageType = detectPageType(cleanText)

    return {
      pageNumber,
      rawText,
      cleanText,
      imageDataUrl,
      usedOCR,
      sourceType,
      pageType,
      keyPoints: createKeyPoints(cleanText, pageType),
      documentNotes: createDocumentNotes(cleanText, pageType, usedOCR),
    }
  }

  async function extractDocxText(file) {
    const arrayBuffer = await file.arrayBuffer()
    const result = await mammoth.extractRawText({ arrayBuffer })
    return result.value || ''
  }

  async function extractPageTextItems(page) {
    const textContent = await page.getTextContent()

    return textContent.items
      .map((item) => ({
        text: item.str.trim(),
        x: Math.round(item.transform[4]),
        y: Math.round(item.transform[5] / 4) * 4,
      }))
      .filter((item) => item.text)
  }

  function formatTextItemsAsLines(textItems) {
    const linesByY = new Map()

    for (const item of textItems) {
      if (!linesByY.has(item.y)) {
        linesByY.set(item.y, [])
      }

      linesByY.get(item.y).push(item)
    }

    return Array.from(linesByY.entries())
      .sort((a, b) => b[0] - a[0])
      .map(([, parts]) =>
        parts
          .sort((a, b) => a.x - b.x)
          .map((part) => part.text)
          .join(' ')
      )
      .join('\n')
  }

  async function renderPageAsImage(page, scale = 1.25) {
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')

    canvas.width = viewport.width
    canvas.height = viewport.height

    await page.render({ canvasContext: context, viewport }).promise

    return canvas.toDataURL('image/jpeg', 0.85)
  }

  function cleanExtractedText(text) {
    return (text || '')
      .replace(/\r/g, '')
      .replace(/[•●▪▫◦]/g, '•')
      .split('\n')
      .map((line) => cleanLine(line))
      .filter(Boolean)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  function cleanLine(line) {
    return line
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .replace(/\bdoesn\s*[’']\s*t\b/gi, 'doesn’t')
      .replace(/\bwouldn\s*[’']\s*t\b/gi, 'wouldn’t')
      .replace(/\bdon\s*[’']\s*t\b/gi, 'don’t')
      .replace(/\bcan\s+be\s+push\b/gi, 'can be pushed')
      .replace(/\bClass\s+2\b/gi, 'Class II')
      .trim()
  }

  function detectPageType(text) {
    const lowerText = text.toLowerCase()

    if (!text.trim()) return 'empty'

    if (
      lowerText.includes('task 2: selection of technologies') ||
      lowerText.includes('option 1') && lowerText.includes('option 2') && lowerText.includes('unit operation') ||
      lowerText.includes('issue identified') && lowerText.includes('possible cause') ||
      lowerText.includes('suggest bfd modification') ||
      lowerText.includes('team discussion') ||
      lowerText.includes('bfd checklist') ||
      lowerText.includes('mass balance')
    ) {
      return 'worksheet'
    }

    if (
      lowerText.includes('team member') &&
      lowerText.includes('unit operation') &&
      (lowerText.includes('why selected') || lowerText.includes('design requirement'))
    ) {
      return 'worksheet'
    }

    if (
      lowerText.includes('learning outcomes') ||
      lowerText.includes('week activities') ||
      lowerText.includes('outline') ||
      lowerText.includes('tutorial class')
    ) {
      return 'navigation'
    }

    if (looksLikeCode(text)) return 'code'

    if (/graph|plot|diagram|figure|axis|axes|curve|flow diagram|bfd/i.test(text)) {
      return 'visual'
    }

    return 'lecture'
  }

  function looksLikeCode(text) {
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
    const codeLines = lines.filter((line) =>
      /^(import|from|def|for|while|if|return|print\(|class)\b/i.test(line) ||
      /^#/.test(line) ||
      /\b(np|pd|plt|pl|rd)\./.test(line) ||
      /\w+\s*=\s*.+/.test(line)
    )

    return codeLines.length >= 3
  }

  function createKeyPoints(text, pageType) {
    if (!text.trim()) {
      return ['No readable text was found on this page. Use the page preview only.']
    }

    if (pageType === 'worksheet') {
      return [
        'This page is a worksheet/table page, so the app does not force it into random revision bullets.',
        'Use the clean extracted text below and the page preview to keep the table structure clear.',
      ]
    }

    if (pageType === 'navigation') {
      return createNavigationPoints(text)
    }

    if (pageType === 'code') {
      return [
        'This page contains code or formula-like text.',
        'Use the clean extracted text and preview together, because rule-based extraction may not understand every code line correctly.',
      ]
    }

    const bulletLines = text
      .split('\n')
      .map((line) => line.replace(/^•\s*/, '').trim())
      .filter((line) => isUsefulLine(line))

    if (bulletLines.length > 0) {
      return unique(bulletLines).slice(0, 5)
    }

    return createSentencePoints(text)
  }

  function createNavigationPoints(text) {
    const lines = text
      .split('\n')
      .map((line) => line.replace(/^•\s*/, '').trim())
      .filter((line) => line.length > 8)
      .filter((line) => !/team members|member \d|selected file|generate notes|clear/i.test(line))

    if (lines.length === 0) {
      return ['This page is mainly for navigation or instructions.']
    }

    return unique(lines).slice(0, 6)
  }

  function createSentencePoints(text) {
    const sentences = text
      .replace(/\n/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length >= 35 && sentence.length <= 220)
      .filter((sentence) => !looksLikeJunk(sentence))

    if (sentences.length === 0) {
      return ['This page is mostly visual or the extracted text is too fragmented. Use the preview and clean extracted text below.']
    }

    return unique(sentences).slice(0, 5)
  }

  function createDocumentNotes(text, pageType, usedOCR) {
    if (pageType === 'worksheet') {
      return {
        title: 'Clean Extracted Text',
        note: 'This is a worksheet/table page. The app shows the cleaned text instead of pretending to fully understand the table layout.',
        mode: 'clean-text',
      }
    }

    if (usedOCR) {
      return {
        title: 'OCR Note',
        note: 'This page was read using OCR. OCR can be noisy, especially for handwriting, tiny text, or screenshots.',
        mode: 'normal',
      }
    }

    if (pageType === 'visual') {
      return {
        title: 'Visual Note',
        note: 'This page contains a visual, table, or diagram. Use the preview together with the extracted text.',
        mode: 'normal',
      }
    }

    return null
  }

  function isUsefulLine(line) {
    if (!line || line.length < 12 || line.length > 220) return false
    if (looksLikeJunk(line)) return false
    if (/^(slide|page)\s*\d+$/i.test(line)) return false
    if (/^(key points|show extracted text|code explanation|visual slide note)$/i.test(line)) return false
    return true
  }

  function looksLikeJunk(text) {
    const lowerText = text.toLowerCase()

    return (
      /selected file|choose file|generate notes|study sprint/i.test(text) ||
      /monash university|school of information technology/i.test(text) ||
      /^(\d+\s*){4,}$/.test(text) ||
      lowerText.includes('no file selected') ||
      lowerText.includes('this code slide was detected')
    )
  }

  function unique(items) {
    return items.filter((item, index, array) => array.indexOf(item) === index)
  }

  function getKeywords(text) {
    const stopWords = new Set([
      'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were',
      'you', 'your', 'have', 'has', 'had', 'not', 'can', 'will', 'into', 'about',
      'using', 'used', 'also', 'they', 'their', 'there', 'which', 'page', 'slide',
      'pdf', 'may', 'more', 'been', 'week', 'task', 'option', 'member', 'selected',
    ])

    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 3 && !stopWords.has(word))

    const counts = {}

    for (const word of words) {
      counts[word] = (counts[word] || 0) + 1
    }

    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([word]) => word)
  }

  function createOverallSummary(fileName, extractedSections) {
    const allText = extractedSections.map((section) => section.cleanText).join('\n')
    const worksheetCount = extractedSections.filter((section) => section.pageType === 'worksheet').length
    const bestPoints = extractedSections
      .flatMap((section) => section.keyPoints)
      .filter((point) => !point.toLowerCase().includes('does not force it into random'))
      .filter((point) => !point.toLowerCase().includes('use the clean extracted text'))
      .filter((point) => !looksLikeJunk(point))
      .filter((point, index, array) => array.indexOf(point) === index)
      .slice(0, 8)

    return {
      fileName,
      totalPages: extractedSections.length,
      keywords: getKeywords(allText),
      documentType: worksheetCount >= Math.ceil(extractedSections.length / 3) ? 'worksheet' : 'lecture',
      mainPoints: bestPoints,
      checklist: [
        'Review the main keywords first.',
        'For lecture slides, read the key points.',
        'For worksheet/table pages, use the clean extracted text and page preview.',
        'Open the extracted text when the table layout matters.',
      ],
    }
  }

  function renderCleanText(text, options = {}) {
    if (!text) {
      return <p className="extracted-line">No readable text found.</p>
    }

    if (options.formatWorksheet) {
      return renderWorksheetText(text)
    }

    const lines = text.split('\n').filter(Boolean)

    return (
      <div className="clean-text-lines">
        {lines.map((line, index) => {
          const isBullet = line.startsWith('•') || /^[-*]\s/.test(line)
          const isHeading = line.length < 90 && /task|step|issue|possible cause|brainstorming|suggest|insert|team|unit operation|option|mass balance|checklist/i.test(line)

          if (isHeading) {
            return <p className="clean-heading" key={index}>{line}</p>
          }

          if (isBullet) {
            return <p className="clean-bullet" key={index}>{line.replace(/^[-*•]\s*/, '')}</p>
          }

          return <p className="clean-line" key={index}>{line}</p>
        })}
      </div>
    )
  }

  function renderWorksheetText(text) {
    const blocks = createWorksheetBlocks(text)

    if (blocks.length === 0) {
      return <p className="extracted-line">No readable worksheet text found.</p>
    }

    return (
      <div className="clean-text-lines worksheet-text-lines">
        {blocks.map((block, index) => {
          if (block.type === 'heading') {
            return <p className="clean-heading" key={index}>{block.text}</p>
          }

          return <p className="clean-bullet" key={index}>{block.text}</p>
        })}
      </div>
    )
  }

  function createWorksheetBlocks(text) {
    const lines = text
      .split('\n')
      .map((line) => cleanLine(line))
      .filter(Boolean)

    const blocks = []
    let paragraphLines = []

    function flushParagraph() {
      if (paragraphLines.length === 0) return

      const paragraph = cleanLine(paragraphLines.join(' '))
      const bulletSentences = splitParagraphIntoReadableBullets(paragraph)

      for (const sentence of bulletSentences) {
        if (sentence.length >= 8) {
          blocks.push({ type: 'bullet', text: sentence })
        }
      }

      paragraphLines = []
    }

    for (const line of lines) {
      if (isWorksheetHeading(line)) {
        flushParagraph()
        blocks.push({ type: 'heading', text: line })
        continue
      }

      if (isStandaloneBullet(line)) {
        flushParagraph()
        blocks.push({ type: 'bullet', text: line.replace(/^[-*•○●▪▫◦]\s*/, '') })
        continue
      }

      paragraphLines.push(line)

      if (endsLikeCompleteSentence(line)) {
        flushParagraph()
      }
    }

    flushParagraph()

    return blocks
  }

  function isWorksheetHeading(line) {
    const cleaned = line.replace(/^\(?[a-z]\)?\s*/i, '').trim()

    return (
      /^\([a-z]\)\s+/i.test(line) ||
      /^task\s+\d+/i.test(line) ||
      /^step\s+\d+/i.test(line) ||
      /^(brainstorming|discussion|team discussion|issue identified|possible cause|affected unit operation|suggest|insert|finally|checklist)/i.test(line) ||
      (line.endsWith(':') && line.length <= 120) ||
      (cleaned.length <= 95 && /bfd|mass balance|modification|discussion|question|operation|technology|configuration|option|checklist/i.test(cleaned))
    )
  }

  function isStandaloneBullet(line) {
    return /^[-*•]\s/.test(line) || /^[○●▪▫◦]\s/.test(line)
  }

  function endsLikeCompleteSentence(line) {
    return /[.!?]$/.test(line.trim())
  }

  function splitParagraphIntoReadableBullets(paragraph) {
    const cleaned = cleanLine(paragraph)
      .replace(/\s+([,.;:!?])/g, '$1')
      .replace(/\s*\/\s*/g, ' / ')

    if (!cleaned) return []

    const sentences = cleaned
      .split(/(?<=[.!?])\s+(?=[A-Z(])/g)
      .map((sentence) => sentence.trim())
      .filter(Boolean)

    if (sentences.length > 1) {
      return sentences
    }

    return cleaned
      .split(/\s+(?=(?:However|Lastly|Therefore|Hence|This is important|This helps|It is important|It can|It will|By changing)\b)/g)
      .map((sentence) => sentence.trim())
      .filter(Boolean)
  }

  function handleClear() {
    setSelectedFile(null)
    setSlides([])
    setOverallSummary(null)
    setStatusMessage('')
    setErrorMessage('')

    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  return (
    <div className="app">
      <section className="hero-card">
        <p className="eyebrow">Lecture Revision Tool</p>
        <h1>Study Sprint</h1>
        <p className="subtitle">
          Turn PDF or DOCX lecture notes into revision notes, clean extracted text, and study checklists.
        </p>

        <div className="upload-box">
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={handleFileChange}
          />

          <p>
            Selected file: <strong>{selectedFile ? selectedFile.name : 'No file selected'}</strong>
          </p>
        </div>

        <div className="button-row">
          <button onClick={handleGenerateNotes} disabled={isLoading}>
            {isLoading ? 'Generating...' : 'Generate Notes'}
          </button>
          <button className="secondary-button" onClick={handleClear}>Clear</button>
        </div>

        {statusMessage && <p className="status">{statusMessage}</p>}
        {errorMessage && <p className="error">{errorMessage}</p>}
      </section>

      {overallSummary && (
        <section className="card">
          <h2>Overall Revision Summary</h2>
          <p className="summary-meta">Revision summary for {overallSummary.fileName}</p>
          <p className="summary-meta">Total sections/pages: {overallSummary.totalPages}</p>

          {overallSummary.documentType === 'worksheet' && (
            <p className="summary-note">
              This looks like a worksheet/table-heavy document. Study Sprint keeps the clean extracted text page-by-page
              instead of forcing complex tables into fake bullet summaries.
            </p>
          )}

          <div className="summary-section">
            <h3>Main Keywords</h3>
            <div className="keyword-chips">
              {overallSummary.keywords.map((keyword) => (
                <span className="keyword-chip" key={keyword}>{keyword}</span>
              ))}
            </div>
          </div>

          {overallSummary.mainPoints.length > 0 && (
            <div className="summary-section">
              <h3>Main Points</h3>
              <ul className="summary-list">
                {overallSummary.mainPoints.map((point, index) => <li key={index}>{point}</li>)}
              </ul>
            </div>
          )}

          <div className="summary-section">
            <h3>Study Checklist</h3>
            <ul className="summary-list">
              {overallSummary.checklist.map((item, index) => <li key={index}>{item}</li>)}
            </ul>
          </div>
        </section>
      )}

      {slides.length > 0 && (
        <section className="card">
          <h2>Slide/Page Notes</h2>

          {slides.map((slide) => (
            <article className="slide-card" key={`${slide.sourceType}-${slide.pageNumber}`}>
              <h3>
                {slide.sourceType === 'docx' ? 'DOCX Section' : `Slide/Page ${slide.pageNumber}`}
                {slide.usedOCR && <span className="ocr-badge">OCR</span>}
              </h3>

              {slide.imageDataUrl && (
                <img className="slide-preview" src={slide.imageDataUrl} alt={`Slide/Page ${slide.pageNumber}`} />
              )}

              <div className="key-points">
                <h4>{slide.pageType === 'worksheet' ? 'Page Type' : 'Key Points'}</h4>
                <ul>
                  {slide.keyPoints.map((point, index) => <li key={index}>{point}</li>)}
                </ul>
              </div>

              {slide.documentNotes && (
                <div className="slide-explanation">
                  <h4>{slide.documentNotes.title}</h4>
                  <p>{slide.documentNotes.note}</p>
                  {slide.documentNotes.mode === 'clean-text' && renderCleanText(slide.cleanText, { formatWorksheet: true })}
                </div>
              )}

              <details>
                <summary>Show raw extracted text</summary>
                <div className="extracted-text">{renderCleanText(slide.rawText)}</div>
              </details>
            </article>
          ))}
        </section>
      )}
    </div>
  )
}

export default App
