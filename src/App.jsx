import { useMemo, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url'
import { createWorker } from 'tesseract.js'
import mammoth from 'mammoth/mammoth.browser'
import './App.css'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker

const MIN_TEXT_LENGTH_BEFORE_OCR = 3
const OCR_CONFIDENCE_WARN = 72

//page type constants so we never rely on loose strings
const PAGE_TYPE = {
  EMPTY: 'empty',
  LECTURE: 'lecture',
  WORKSHEET: 'worksheet',
  DIAGRAM: 'diagram',
  OCR_RISKY: 'ocr-risky',
  FORMULA: 'formula',
}

const PAGE_TYPE_LABEL = {
  [PAGE_TYPE.EMPTY]: 'Empty / preview only',
  [PAGE_TYPE.LECTURE]: 'Lecture slide',
  [PAGE_TYPE.WORKSHEET]: 'Worksheet / table',
  [PAGE_TYPE.DIAGRAM]: 'Diagram / preview important',
  [PAGE_TYPE.OCR_RISKY]: 'Handwritten / OCR risky',
  [PAGE_TYPE.FORMULA]: 'Formula / calculation',
}

function App() {
  const fileInputRef = useRef(null)

  const [selectedFile, setSelectedFile] = useState(null)
  const [slides, setSlides] = useState([])
  const [fileName, setFileName] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [statusMessage, setStatusMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')

  //derived analysis recomputes when a page is edited or confirmed
  const analysis = useMemo(() => {
    if (slides.length === 0) return null
    return buildAnalysis(fileName, slides)
  }, [slides, fileName])

  function handleFileChange(event) {
    const file = event.target.files[0]
    if (!file) return

    const name = file.name.toLowerCase()
    const isPdf = name.endsWith('.pdf')
    const isDocx = name.endsWith('.docx')

    if (!isPdf && !isDocx) {
      alert('Please upload a PDF or DOCX file.')
      return
    }

    setSelectedFile(file)
    setSlides([])
    setFileName('')
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
    setErrorMessage('')
    setStatusMessage('Reading file...')

    let ocrWorker = null

    try {
      const name = selectedFile.name.toLowerCase()
      const pages = []

      if (name.endsWith('.docx')) {
        setStatusMessage('Reading DOCX file...')
        const text = await extractDocxText(selectedFile)
        const cleanText = cleanExtractedText(text)

        if (!cleanText.trim()) {
          throw new Error('DOCX file has no readable text.')
        }

        pages.push(createPage({
          pageNumber: 1,
          rawText: text,
          cleanText,
          imageDataUrl: '',
          usedOCR: false,
          ocrConfidence: null,
          tabular: computeTableScoreFromText(cleanText) >= 3,
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
          let tableScore = computeTableScoreFromItems(textItems)
          const imageDataUrl = await renderPageAsImage(page)
          let usedOCR = false
          let ocrConfidence = null

          if (rawText.trim().length < MIN_TEXT_LENGTH_BEFORE_OCR) {
            setStatusMessage(`Page ${pageNumber} has no selectable text. Running OCR...`)

            if (!ocrWorker) {
              ocrWorker = await createWorker('eng')
            }

            const ocrImageDataUrl = await renderPageAsImage(page, 2.2)
            const { data } = await ocrWorker.recognize(ocrImageDataUrl)
            rawText = data.text || ''
            ocrConfidence = typeof data.confidence === 'number' ? data.confidence : null
            usedOCR = true
            tableScore = computeTableScoreFromText(rawText)
          }

          const cleanText = cleanExtractedText(rawText)

          pages.push(createPage({
            pageNumber,
            rawText,
            cleanText,
            imageDataUrl,
            usedOCR,
            ocrConfidence,
            tabular: tableScore >= 3,
            sourceType: 'pdf',
          }))
        }
      }

      setFileName(selectedFile.name)
      setSlides(pages)
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

  //build a page record. detection uses text + ocr signals so we can flag risky pages
  function createPage({ pageNumber, rawText, cleanText, imageDataUrl, usedOCR, ocrConfidence, tabular, sourceType }) {
    const pageType = detectPageType({ cleanText, usedOCR, ocrConfidence, tabular })
    const needsReview =
      pageType === PAGE_TYPE.OCR_RISKY ||
      pageType === PAGE_TYPE.EMPTY

    return {
      pageNumber,
      rawText,
      cleanText,
      editedText: cleanText, //user can correct OCR text here
      imageDataUrl,
      usedOCR,
      ocrConfidence,
      tabular,
      sourceType,
      pageType,
      needsReview,
      confirmed: false, //true once the user checks the OCR text
      keyPoints: createKeyPoints(cleanText, pageType),
    }
  }

  //--- editing / confirming handlers -------------------------------------

  function updatePageText(pageNumber, sourceType, value) {
    setSlides((current) =>
      current.map((page) =>
        page.pageNumber === pageNumber && page.sourceType === sourceType
          ? { ...page, editedText: value }
          : page
      )
    )
  }

  function toggleConfirmPage(pageNumber, sourceType) {
    setSlides((current) =>
      current.map((page) =>
        page.pageNumber === pageNumber && page.sourceType === sourceType
          ? { ...page, confirmed: !page.confirmed, needsReview: page.confirmed }
          : page
      )
    )
  }

  function handleClear() {
    setSelectedFile(null)
    setSlides([])
    setFileName('')
    setStatusMessage('')
    setErrorMessage('')

    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  //=========================== rendering =================================

  return (
    <div className="app">
      <section className="hero-card">
        <p className="eyebrow">Lecture Revision Tool</p>
        <h1>Study Sprint</h1>
        <p className="subtitle">
          Turn PDF or DOCX lecture notes into grouped revision notes, clean extracted text, and a study checklist.
          Messy worksheets, tables, and handwriting are flagged instead of forced into fake bullet points.
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

      {analysis && (
        <>
          <OverallSummaryCard analysis={analysis} />

          {analysis.groups.map((group) => (
            <GroupCard
              key={group.id}
              group={group}
              onEditText={updatePageText}
              onToggleConfirm={toggleConfirmPage}
            />
          ))}

          <ChecklistCard checklist={analysis.checklist} />
        </>
      )}
    </div>
  )
}

//============================ UI components ==============================

function OverallSummaryCard({ analysis }) {
  return (
    <section className="card">
      <h2>Overall Revision Summary</h2>
      <p className="summary-meta">Revision summary for {analysis.fileName}</p>
      <p className="summary-meta">Total sections/pages: {analysis.totalPages}</p>
      <p className="summary-meta">Sections found: {analysis.groups.length}</p>

      {analysis.documentType === 'worksheet' && (
        <p className="summary-note">
          This looks like a worksheet / table-heavy document. Study Sprint keeps the clean extracted text per section
          instead of forcing tables into fake bullet summaries.
        </p>
      )}

      <div className="summary-section">
        <h3>Main Keywords</h3>
        <div className="keyword-chips">
          {analysis.keywords.map((keyword) => (
            <span className="keyword-chip" key={keyword}>{keyword}</span>
          ))}
        </div>
      </div>

      {analysis.mainPoints.length > 0 ? (
        <div className="summary-section">
          <h3>Main Points (from grouped content)</h3>
          <ul className="summary-list">
            {analysis.mainPoints.map((point, index) => <li key={index}>{point}</li>)}
          </ul>
        </div>
      ) : (
        <div className="summary-section">
          <h3>Main Points</h3>
          <p className="summary-note">
            No page could be summarised safely yet. The content is mostly tables, diagrams, or handwriting.
            Confirm the OCR text below to include it.
          </p>
        </div>
      )}

      <div className="summary-section">
        <h3>Sections Detected</h3>
        <ul className="summary-list">
          {analysis.groups.map((group) => (
            <li key={group.id}>
              <strong>{group.title}</strong> — pages {formatPageList(group.pages)} ({statusLabel(group.summary.status)})
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function GroupCard({ group, onEditText, onToggleConfirm }) {
  return (
    <section className="card group-card">
      <div className="group-header">
        <h2>{group.title}</h2>
        <span className={`status-pill status-${group.summary.status}`}>{statusLabel(group.summary.status)}</span>
      </div>
      <p className="summary-meta">Pages included: {formatPageList(group.pages)}</p>

      <div className="thumb-row">
        {group.pages.map((page) =>
          page.imageDataUrl ? (
            <img
              className="thumb"
              key={`${page.sourceType}-${page.pageNumber}`}
              src={page.imageDataUrl}
              alt={`Page ${page.pageNumber} preview`}
              title={`Page ${page.pageNumber}`}
            />
          ) : (
            <div className="thumb thumb-empty" key={`${page.sourceType}-${page.pageNumber}`}>
              {page.sourceType === 'docx' ? 'DOCX' : `p.${page.pageNumber}`}
            </div>
          )
        )}
      </div>

      {group.summary.status === 'summary' && (
        <div className="slide-explanation">
          <h4>Section Summary</h4>
          <ul className="summary-list">
            {group.summary.bullets.map((point, index) => <li key={index}>{point}</li>)}
          </ul>
        </div>
      )}

      {group.summary.status === 'extracted-only' && (
        <p className="summary-note">{group.summary.note}</p>
      )}

      {group.summary.status === 'needs-review' && (
        <p className="warning-banner">{group.summary.note}</p>
      )}

      <details className="group-pages">
        <summary>Show pages in this section ({group.pages.length})</summary>
        {group.pages.map((page) => (
          <PageDetail
            key={`${page.sourceType}-${page.pageNumber}`}
            page={page}
            onEditText={onEditText}
            onToggleConfirm={onToggleConfirm}
          />
        ))}
      </details>
    </section>
  )
}

function PageDetail({ page, onEditText, onToggleConfirm }) {
  const title = page.sourceType === 'docx' ? 'DOCX Section' : `Slide/Page ${page.pageNumber}`

  return (
    <article className="slide-card">
      <h3>
        {title}
        <span className={`page-type-badge type-${page.pageType}`}>{PAGE_TYPE_LABEL[page.pageType]}</span>
        {page.usedOCR && <span className="ocr-badge">OCR</span>}
      </h3>

      {page.imageDataUrl && (
        <img className="slide-preview" src={page.imageDataUrl} alt={`Slide/Page ${page.pageNumber}`} />
      )}

      {/* handwritten / OCR risky: no auto summary, editable box + needs review */}
      {page.pageType === PAGE_TYPE.OCR_RISKY && (
        <div className="ocr-review">
          <p className="warning-banner">
            {page.confirmed
              ? 'You confirmed this OCR text. It is now included in the section summary.'
              : `This page was read with OCR${page.ocrConfidence != null ? ` (~${Math.round(page.ocrConfidence)}% confidence)` : ''} and looks risky (handwriting, tiny text, or noise). It is NOT auto-summarised. Please check and edit the text, then confirm.`}
          </p>
          {!page.confirmed && <span className="needs-review-label">Needs review</span>}
          <textarea
            className="editable-ocr"
            value={page.editedText}
            onChange={(event) => onEditText(page.pageNumber, page.sourceType, event.target.value)}
            rows={Math.min(14, Math.max(4, page.editedText.split('\n').length + 1))}
            placeholder="Corrected OCR text goes here..."
          />
          <button
            className={page.confirmed ? 'secondary-button' : ''}
            onClick={() => onToggleConfirm(page.pageNumber, page.sourceType)}
          >
            {page.confirmed ? 'Mark as needs review again' : 'Confirm text as correct'}
          </button>
        </div>
      )}

      {/* worksheet / table: warning + clean extracted text, no invented bullets */}
      {page.pageType === PAGE_TYPE.WORKSHEET && (
        <div className="slide-explanation">
          <p className="warning-banner">
            This page is table-heavy. Review the preview before using the text. Columns may not line up in plain text.
          </p>
          <h4>Clean Extracted Text (by section)</h4>
          {renderWorksheetText(page.cleanText)}
        </div>
      )}

      {/* diagram: preview matters most */}
      {page.pageType === PAGE_TYPE.DIAGRAM && (
        <div className="slide-explanation">
          <p className="summary-note">
            This page is mostly a diagram or figure. Use the preview image above as the main reference; the text
            below is only a partial extraction.
          </p>
          {renderCleanText(page.cleanText)}
        </div>
      )}

      {/* formula / calculation */}
      {page.pageType === PAGE_TYPE.FORMULA && (
        <div className="slide-explanation">
          <p className="summary-note">
            This page contains formulas, calculations, or code. Rule-based extraction may reorder symbols, so check
            against the preview.
          </p>
          {renderCleanText(page.cleanText)}
        </div>
      )}

      {/* normal lecture slide: key points */}
      {page.pageType === PAGE_TYPE.LECTURE && (
        <div className="key-points">
          <h4>Key Points</h4>
          <ul>
            {page.keyPoints.map((point, index) => <li key={index}>{point}</li>)}
          </ul>
        </div>
      )}

      {/* empty */}
      {page.pageType === PAGE_TYPE.EMPTY && (
        <p className="warning-banner">
          No readable text was found on this page. Use the page preview only.
        </p>
      )}

      <details>
        <summary>Show raw extracted text</summary>
        <div className="extracted-text">{renderCleanText(page.rawText)}</div>
      </details>
    </article>
  )
}

function ChecklistCard({ checklist }) {
  const buckets = [
    { key: 'summarised', title: 'Pages safely summarised', className: 'bucket-good' },
    { key: 'extracted', title: 'Pages kept as extracted text', className: 'bucket-info' },
    { key: 'review', title: 'Pages needing manual review', className: 'bucket-warn' },
    { key: 'ocr', title: 'OCR-risk pages', className: 'bucket-ocr' },
  ]

  return (
    <section className="card">
      <h2>Final Checklist</h2>
      <div className="checklist-grid">
        {buckets.map((bucket) => (
          <div className={`checklist-bucket ${bucket.className}`} key={bucket.key}>
            <h4>{bucket.title}</h4>
            {checklist[bucket.key].length > 0 ? (
              <p className="bucket-pages">Pages: {checklist[bucket.key].join(', ')}</p>
            ) : (
              <p className="bucket-pages muted">None</p>
            )}
          </div>
        ))}
      </div>
      <div className="summary-section">
        <h3>How to revise</h3>
        <ul className="summary-list">
          <li>Read the main keywords and grouped section summaries first.</li>
          <li>For worksheet/table sections, use the preview and clean extracted text side by side.</li>
          <li>Confirm any OCR-risk pages before trusting their text.</li>
          <li>Treat "needs manual review" sections as reminders to check the original slide.</li>
        </ul>
      </div>
    </section>
  )
}

//========================== extraction helpers ==========================

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

//count how many text lines look like table rows (>=3 items spread across x)
function computeTableScoreFromItems(textItems) {
  const linesByY = new Map()

  for (const item of textItems) {
    if (!linesByY.has(item.y)) {
      linesByY.set(item.y, [])
    }
    linesByY.get(item.y).push(item)
  }

  let rowLikeLines = 0

  for (const parts of linesByY.values()) {
    if (parts.length < 3) continue
    const xs = parts.map((p) => p.x).sort((a, b) => a - b)
    const spread = xs[xs.length - 1] - xs[0]
    //3+ separate items spread across a wide area => probably a table row
    if (spread > 150) rowLikeLines += 1
  }

  return rowLikeLines
}

//table detection for plain OCR / docx text via multi-space or tab gaps
function computeTableScoreFromText(text) {
  const lines = (text || '').split('\n').map((line) => line.trim()).filter(Boolean)
  let rowLikeLines = 0

  for (const line of lines) {
    const columns = line.split(/\t+|\s{2,}/).filter(Boolean)
    if (columns.length >= 3) rowLikeLines += 1
  }

  return rowLikeLines
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

//========================= page type detection ==========================

function detectPageType({ cleanText, usedOCR, ocrConfidence, tabular }) {
  const text = cleanText || ''
  const lowerText = text.toLowerCase()

  if (!text.trim()) return PAGE_TYPE.EMPTY

  //OCR pages that look noisy or low confidence should never be auto-summarised
  if (usedOCR && ocrLooksRisky(text, ocrConfidence)) {
    return PAGE_TYPE.OCR_RISKY
  }

  //worksheet keywords OR a genuine table layout
  if (tabular || looksLikeWorksheet(lowerText)) {
    return PAGE_TYPE.WORKSHEET
  }

  //formulas, calculations, or code
  if (looksLikeFormula(text) || looksLikeCode(text)) {
    return PAGE_TYPE.FORMULA
  }

  //diagram-heavy page: visual keywords but not much readable prose
  if (looksLikeDiagram(lowerText) && countWords(text) < 45) {
    return PAGE_TYPE.DIAGRAM
  }

  return PAGE_TYPE.LECTURE
}

function ocrLooksRisky(text, confidence) {
  if (confidence != null && confidence < OCR_CONFIDENCE_WARN) return true

  const tokens = text.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true

  const weird = tokens.filter((token) =>
    /[^\x20-\x7e]/.test(token) ||                  //non-printable / non-ascii junk
    (token.length >= 4 && !/[aeiou]/i.test(token)) || //long token, no vowels
    /[a-z][A-Z][a-z]/.test(token) ||               //odd internal casing
    (token.length === 1 && !/[aioAIO0-9]/.test(token)) //stray single characters
  )

  const symbols = text.replace(/[a-zA-Z0-9\s]/g, '').length
  const symbolRatio = symbols / Math.max(text.length, 1)

  return (weird.length / tokens.length) > 0.35 || symbolRatio > 0.28
}

function looksLikeWorksheet(lowerText) {
  return (
    lowerText.includes('task 2: selection of technologies') ||
    (lowerText.includes('option 1') && lowerText.includes('option 2')) ||
    (lowerText.includes('issue identified') && lowerText.includes('possible cause')) ||
    lowerText.includes('suggest bfd modification') ||
    lowerText.includes('team discussion') ||
    lowerText.includes('bfd checklist') ||
    (lowerText.includes('unit operation') && lowerText.includes('why selected')) ||
    (lowerText.includes('team member') && lowerText.includes('unit operation'))
  )
}

function looksLikeFormula(text) {
  const mathChars = (text.match(/[=+×÷∑∫√±≈≤≥→∆∂]|\^\d|_\{|\bmol\b|\bkg\/h\b|kmol/gi) || []).length
  const digitGroups = (text.match(/\d+(?:\.\d+)?/g) || []).length
  const words = countWords(text)

  //lots of math symbols, or a page dominated by numbers rather than prose
  if (mathChars >= 4) return true
  if (words > 0 && digitGroups >= 8 && digitGroups / words > 0.4) return true
  return false
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

function looksLikeDiagram(lowerText) {
  return /graph|plot|diagram|figure|axis|axes|curve|flow diagram|\bbfd\b|schematic|block flow/.test(lowerText)
}

function countWords(text) {
  return (text.match(/[a-zA-Z]{2,}/g) || []).length
}

//======================= per-page key points ============================

function createKeyPoints(text, pageType) {
  if (!text.trim()) {
    return ['No readable text was found on this page. Use the page preview only.']
  }

  if (pageType !== PAGE_TYPE.LECTURE) {
    //non-lecture pages are handled by their own dedicated views; keep this light
    return ['See the section note and preview for this page.']
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

function createSentencePoints(text) {
  const sentences = extractCompleteSentences(text)

  if (sentences.length === 0) {
    return ['This page is mostly visual or the extracted text is too fragmented. Use the preview and clean extracted text.']
  }

  return unique(sentences).slice(0, 5)
}

//complete sentences only - this is how we avoid fragment bullets.
//split per line first so we never stitch separate table rows/columns into one "sentence".
function extractCompleteSentences(text) {
  return (text || '')
    .split('\n')
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z(])/g))
    .map((sentence) => sentence.trim())
    .filter(isSummaryWorthy)
}

//accept a full sentence, or a clean capitalised clause; reject fragments and table rows
function isSummaryWorthy(sentence) {
  if (!sentence || sentence.length < 30 || sentence.length > 240) return false
  if (looksLikeJunk(sentence)) return false

  const words = sentence.split(/\s+/).filter(Boolean)
  if (words.length < 5) return false

  //reject table-like rows (3+ columns separated by tabs or big gaps)
  if (sentence.split(/\t+|\s{2,}/).filter(Boolean).length >= 3) return false

  //must be mostly letters, not a row of numbers/symbols
  const alpha = (sentence.match(/[a-zA-Z]/g) || []).length
  if (alpha / sentence.length < 0.55) return false

  //a lower-case start that does not end in punctuation is usually a mid-fragment
  if (/^[a-z]/.test(sentence) && !/[.!?]$/.test(sentence)) return false

  return true
}

function isUsefulLine(line) {
  if (!line || line.length < 12 || line.length > 220) return false
  if (looksLikeJunk(line)) return false
  if (/^(slide|page)\s*\d+$/i.test(line)) return false
  if (/^(key points|show extracted text|code explanation|visual slide note)$/i.test(line)) return false
  //reject obvious fragments: must contain a few words and not be a bare label
  if (line.split(/\s+/).length < 3) return false
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

//============================== grouping ================================

//ordered group specs. each page joins the FIRST group whose match passes.
//specific domain groups first, then generic fallbacks by page type.
const GROUP_SPECS = [
  {
    id: 'bfd-diagnosis',
    title: 'BFD diagnosis / problem identification',
    match: (t, page) =>
      /issue identified|possible cause|problem identification|diagnos|what is wrong|affected unit operation|brainstorm/.test(t) &&
      page.pageType !== PAGE_TYPE.OCR_RISKY,
  },
  {
    id: 'bfd-modification',
    title: 'BFD modification',
    match: (t, page) =>
      /suggest bfd modification|bfd modification|modify the bfd|revised bfd|improved bfd|insert (a |the )?unit|add (a |the )?unit/.test(t) &&
      page.pageType !== PAGE_TYPE.OCR_RISKY,
  },
  {
    id: 'tech-selection',
    title: 'Technology selection table',
    match: (t) =>
      /selection of technologies|technology selection|why selected|design requirement/.test(t) ||
      (/option 1/.test(t) && /option 2/.test(t) && /unit operation/.test(t)),
  },
  {
    id: 'mass-balance-instructions',
    title: 'Mass balance instructions',
    match: (t, page) =>
      /mass balance/.test(t) &&
      /instruction|step|procedure|calculate|determine|complete the|fill in|task/.test(t) &&
      page.pageType !== PAGE_TYPE.OCR_RISKY,
  },
  {
    id: 'mass-balance-handwritten',
    title: 'Handwritten mass balance calculations',
    match: (t, page) =>
      page.pageType === PAGE_TYPE.OCR_RISKY &&
      (/mass balance|flow|kg|mol|balance|=|calc/.test(t) || page.usedOCR),
  },
  {
    id: 'mass-balance-final',
    title: 'Final mass balance summary',
    match: (t) =>
      /final mass balance|overall mass balance|mass balance summary|summary of mass balance|total mass balance|results/.test(t),
  },
]

//generic fallback groups keyed by page type
const FALLBACK_GROUPS = {
  [PAGE_TYPE.LECTURE]: { id: 'lecture-content', title: 'Lecture content' },
  [PAGE_TYPE.FORMULA]: { id: 'formulas', title: 'Formulas & calculations' },
  [PAGE_TYPE.WORKSHEET]: { id: 'worksheets', title: 'Worksheets & tables' },
  [PAGE_TYPE.DIAGRAM]: { id: 'diagrams', title: 'Diagrams & visuals' },
  [PAGE_TYPE.OCR_RISKY]: { id: 'needs-review', title: 'Handwritten / needs manual review' },
  [PAGE_TYPE.EMPTY]: { id: 'needs-review', title: 'Handwritten / needs manual review' },
}

function assignGroup(page) {
  const matchText = (page.cleanText || '').toLowerCase()

  for (const spec of GROUP_SPECS) {
    if (spec.match(matchText, page)) {
      return { id: spec.id, title: spec.title }
    }
  }

  return FALLBACK_GROUPS[page.pageType] || FALLBACK_GROUPS[PAGE_TYPE.LECTURE]
}

function buildGroups(pages) {
  const order = []
  const byId = new Map()

  for (const page of pages) {
    const { id, title } = assignGroup(page)

    if (!byId.has(id)) {
      byId.set(id, { id, title, pages: [] })
      order.push(id)
    }
    byId.get(id).pages.push(page)
  }

  return order.map((id) => {
    const group = byId.get(id)
    return { ...group, summary: buildGroupSummary(group) }
  })
}

//summarise a group. rules:
// - tables/worksheets: extracted text only, no invented bullets
// - handwriting/ocr: only if confirmed, else needs-review
// - lecture/formula: complete-sentence bullets only
function buildGroupSummary(group) {
  const pages = group.pages
  const kinds = new Set(pages.map((p) => p.pageType))

  const worksheetHeavy =
    pages.filter((p) => p.pageType === PAGE_TYPE.WORKSHEET || p.pageType === PAGE_TYPE.DIAGRAM).length >=
    Math.ceil(pages.length / 2)

  //pages that are safe to summarise into sentences
  const safePages = pages.filter((page) => {
    if (page.pageType === PAGE_TYPE.LECTURE) return true
    if (page.pageType === PAGE_TYPE.FORMULA) return true
    if (page.pageType === PAGE_TYPE.OCR_RISKY && page.confirmed) return true
    return false
  })

  if (safePages.length === 0) {
    if (kinds.has(PAGE_TYPE.OCR_RISKY) || kinds.has(PAGE_TYPE.EMPTY)) {
      return {
        status: 'needs-review',
        bullets: [],
        note: 'This section is handwritten / OCR-risky or empty. Confirm the text on each page before it can be summarised. Needs manual review.',
      }
    }
    return {
      status: 'extracted-only',
      bullets: [],
      note: 'This section is table-heavy or diagram-heavy. Study Sprint keeps the clean extracted text per page instead of inventing bullet points. Review the previews below.',
    }
  }

  if (worksheetHeavy && safePages.length < Math.ceil(pages.length / 2)) {
    return {
      status: 'extracted-only',
      bullets: [],
      note: 'Mostly tables/diagrams. The readable pages are kept as extracted text below. Summarise by row/section using the previews.',
    }
  }

  //collect complete-sentence bullets from safe text
  const source = safePages
    .map((page) => (page.pageType === PAGE_TYPE.OCR_RISKY ? page.editedText : page.cleanText))
    .join('\n')

  const bullets = unique(extractCompleteSentences(source)).slice(0, 6)

  if (bullets.length === 0) {
    return {
      status: 'needs-review',
      bullets: [],
      note: 'The text here is too fragmented to summarise into full sentences. Needs manual review — use the previews and extracted text.',
    }
  }

  return { status: 'summary', bullets, note: '' }
}

//=========================== overall summary ============================

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

function buildChecklist(pages) {
  const summarised = []
  const extracted = []
  const review = []
  const ocr = []

  for (const page of pages) {
    const label = page.sourceType === 'docx' ? 'DOCX' : page.pageNumber

    if (page.usedOCR) ocr.push(label)

    if (page.pageType === PAGE_TYPE.LECTURE || page.pageType === PAGE_TYPE.FORMULA) {
      summarised.push(label)
    } else if (page.pageType === PAGE_TYPE.WORKSHEET || page.pageType === PAGE_TYPE.DIAGRAM) {
      extracted.push(label)
    } else if (page.pageType === PAGE_TYPE.OCR_RISKY) {
      if (page.confirmed) {
        summarised.push(label)
      } else {
        review.push(label)
      }
    } else {
      review.push(label)
    }
  }

  return { summarised, extracted, review, ocr }
}

function buildAnalysis(fileName, pages) {
  const groups = buildGroups(pages)
  const allText = pages.map((page) => page.cleanText).join('\n')
  const worksheetCount = pages.filter(
    (page) => page.pageType === PAGE_TYPE.WORKSHEET || page.pageType === PAGE_TYPE.DIAGRAM
  ).length

  //main points come only from groups that were safely summarised
  const mainPoints = unique(
    groups
      .filter((group) => group.summary.status === 'summary')
      .flatMap((group) => group.summary.bullets)
  ).slice(0, 8)

  return {
    fileName,
    totalPages: pages.length,
    keywords: getKeywords(allText),
    documentType: worksheetCount >= Math.ceil(pages.length / 3) ? 'worksheet' : 'lecture',
    mainPoints,
    groups,
    checklist: buildChecklist(pages),
  }
}

//======================= shared render helpers ==========================

function formatPageList(pages) {
  return pages.map((page) => (page.sourceType === 'docx' ? 'DOCX' : page.pageNumber)).join(', ')
}

function statusLabel(status) {
  if (status === 'summary') return 'summarised'
  if (status === 'extracted-only') return 'extracted text kept'
  return 'needs review'
}

function renderCleanText(text) {
  if (!text) {
    return <p className="extracted-line">No readable text found.</p>
  }

  const lines = text.split('\n').filter(Boolean)

  return (
    <div className="clean-text-lines">
      {lines.map((line, index) => {
        const isBullet = line.startsWith('•') || /^[-*]\s/.test(line)
        const isHeading =
          line.length < 90 &&
          /task|step|issue|possible cause|brainstorming|suggest|insert|team|unit operation|option|mass balance|checklist/i.test(line)

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
      {blocks.map((block, index) =>
        block.type === 'heading'
          ? <p className="clean-heading" key={index}>{block.text}</p>
          : <p className="clean-bullet" key={index}>{block.text}</p>
      )}
    </div>
  )
}

//split worksheet text into headings + row/section blocks (never merge columns)
function createWorksheetBlocks(text) {
  const lines = text.split('\n').map((line) => cleanLine(line)).filter(Boolean)
  const blocks = []

  for (const line of lines) {
    if (isWorksheetHeading(line)) {
      blocks.push({ type: 'heading', text: line })
      continue
    }
    //each source line becomes its own block - we do NOT stitch columns together
    blocks.push({ type: 'row', text: line.replace(/^[-*•○●▪▫◦]\s*/, '') })
  }

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

export default App
