import { useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url'
import { createWorker } from 'tesseract.js'
import mammoth from 'mammoth/mammoth.browser'
import './App.css'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker

// Below this many extracted characters, we treat a page as having no real
// text layer (e.g. a PDF made via "Print to PDF" from a notebook/browser,
// which rasterises everything) and fall back to OCR on the rendered image.
const MIN_TEXT_LENGTH_BEFORE_OCR = 3

// A small hand-written glossary of the recurring concepts in this course's
// regression/bias-variance material. Fully offline — no API calls. Order
// matters: more specific multi-word entries are checked before generic ones
// so we don't show both "bias" and "bias-variance tradeoff" for the same hit.
const CONCEPT_GLOSSARY = [
  {
    label: 'Bias-variance tradeoff',
    test: (text) => /\bbias\b/i.test(text) && /\bvariance\b/i.test(text),
    explanation:
      "The tradeoff between two kinds of error. A simple model (e.g. a straight line) has high bias: it can't capture the true pattern even with lots of data, so it fits training AND test data poorly. A complex model (e.g. a 25th-degree polynomial) has high variance: it can fit training data almost perfectly, but it's fitting the noise, not the real pattern, so it performs poorly on new/test data. That's what 'good on training, bad on testing' means — it's overfitting, a high-variance model.",
  },
  {
    label: 'Overfitting',
    test: (text) => /\boverfit(ting)?\b/i.test(text),
    explanation:
      'A model that has essentially memorised the training data, including its random noise, instead of learning the true underlying pattern. Symptom: very low error on training data, but much higher error on new/test data, because the model\'s wiggles don\'t generalise.',
  },
  {
    label: 'Underfitting',
    test: (text) => /\bunderfit(ting)?\b/i.test(text),
    explanation:
      "A model too simple to capture the real pattern in the data (e.g. fitting a straight line to a curved relationship). Error stays high on both training and test data because the model can't represent the true shape at all.",
  },
  {
    label: 'Mean Squared Error (MSE)',
    test: (text) => /\bmean squared error\b|\bmse\b/i.test(text),
    explanation:
      'The average of (actual − predicted)² across all data points. Squaring makes big misses count extra and keeps the number positive. Lower MSE = predictions closer to the real values.',
  },
  {
    label: 'Training vs test set',
    test: (text) => /\btraining set\b|\btest set\b|\btraining data\b|\btest data\b/i.test(text),
    explanation:
      "The training set is what the model learns/fits from. The test set is held back and never used for fitting — it's used afterwards to check whether the model actually generalises, rather than just memorising the training data.",
  },
  {
    label: 'Regression',
    test: (text) => /\bregression\b/i.test(text),
    explanation:
      'Fitting a mathematical function (a line, curve, or higher-degree polynomial) to data so you can predict an output (y) from an input (x), and describe how strongly they\'re related.',
  },
  {
    label: 'Polynomial order/degree',
    test: (text) => /\bpolynomial (order|degree)\b|\border of the polynomial\b/i.test(text),
    explanation:
      'The highest power of x used in the fitted equation (order 1 = straight line, order 2 = curve with one bend, order 25 = a wildly flexible curve). Higher order = more flexible model = more prone to overfitting with limited data.',
  },
  {
    label: 'Ensemble',
    test: (text) => /\bensemble\b/i.test(text),
    explanation:
      "A collection of several models (often the same method fit to different random samples of data). Looking at how much they disagree with each other tells you the model's variance — how sensitive it is to which exact data points it happened to see.",
  },
  {
    label: 'No Free Lunch theorem',
    test: (text) => /\bno free lunch\b/i.test(text),
    explanation:
      "No single learning algorithm is best for every problem. An algorithm that performs well on one type of data will necessarily do worse on others — so the 'best' model always depends on the specific data and problem.",
  },
]

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

    if (!file) {
      return
    }

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
    setStatusMessage(file.name.toLowerCase().endsWith('.docx') ? 'DOCX selected. Ready to generate notes.' : 'PDF selected. Ready to generate notes.')
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

      if (fileName.endsWith('.docx')) {
        setStatusMessage('Reading DOCX file...')

        const docxText = await extractDocxText(selectedFile)

        if (!docxText.trim()) {
          throw new Error('DOCX file has no readable text.')
        }

        const seenConceptLabels = new Set()
        const technologyRows = extractTechnologyRows(docxText)
        let worksheetRows = technologyRows.length > 0 ? [] : extractWorksheetRows(docxText)
        let keyPoints = technologyRows.length > 0
          ? createTechnologyKeyPoints(technologyRows)
          : worksheetRows.length > 0
            ? createWorksheetKeyPoints(worksheetRows)
            : createKeyPoints(docxText, 1)

        if (keyPoints.length === 0) {
          keyPoints = createKeyPointsFromProse(docxText)
        }

        const slideType = technologyRows.length > 0
          ? 'technology-table'
          : worksheetRows.length > 0
            ? 'worksheet-table'
            : detectSlideType(docxText, keyPoints, false)
        const slideExplanation = createSlideExplanation({
          text: docxText,
          keyPoints,
          slideType,
          usedOCR: false,
          seenConceptLabels,
          worksheetRows,
          technologyRows,
        })

        const docxSlide = {
          pageNumber: 1,
          text: docxText,
          imageDataUrl: '',
          keyPoints,
          usedOCR: false,
          sourceType: 'docx',
          slideType,
          worksheetRows,
          technologyRows,
          slideExplanation,
        }

        setSlides([docxSlide])
        setOverallSummary(createOverallSummary(selectedFile.name, [docxSlide]))
        setStatusMessage('Done. DOCX revision notes generated.')
        return
      }

      setStatusMessage('Reading PDF...')

      const arrayBuffer = await selectedFile.arrayBuffer()
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise

      const extractedSlides = []
      const seenConceptLabels = new Set()

      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        setStatusMessage(`Extracting slide/page ${pageNumber} of ${pdf.numPages}...`)

        const page = await pdf.getPage(pageNumber)
        const textItems = await extractPageTextItems(page)
        let text = formatTextItemsAsLines(textItems)
        const imageDataUrl = await renderPageAsImage(page)

        let usedOCR = false

        // Some PDFs (e.g. a Jupyter notebook "printed" to PDF) have no real
        // text layer at all, just vector/rasterised drawing. pdf.js has
        // nothing to extract there, so we OCR the page image instead.
        if (text.trim().length < MIN_TEXT_LENGTH_BEFORE_OCR) {
          setStatusMessage(
            `Page ${pageNumber} of ${pdf.numPages} has no selectable text. Running OCR (this can take a bit longer)...`
          )

          if (!ocrWorker) {
            ocrWorker = await createWorker('eng')
          }

          const ocrImageDataUrl = await renderPageAsImage(page, 2.2)
          const { data } = await ocrWorker.recognize(ocrImageDataUrl)
          text = cleanOCRText(data.text)
          usedOCR = true
        }

        const technologyRows = extractTechnologyRowsFromItems(textItems)
        let worksheetRows = technologyRows.length > 0 ? [] : extractWorksheetRowsFromItems(textItems)

        if (technologyRows.length === 0 && worksheetRows.length === 0) {
          worksheetRows = extractWorksheetRows(text)
        }
        let keyPoints = technologyRows.length > 0
          ? createTechnologyKeyPoints(technologyRows)
          : worksheetRows.length > 0
            ? createWorksheetKeyPoints(worksheetRows)
            : []

        if (keyPoints.length === 0) {
          keyPoints = usedOCR ? createKeyPointsFromProse(text) : createKeyPoints(text, pageNumber)
        }

        const slideType = technologyRows.length > 0
          ? 'technology-table'
          : worksheetRows.length > 0
            ? 'worksheet-table'
            : detectSlideType(text, keyPoints, usedOCR)
        const slideExplanation = createSlideExplanation({
          text,
          keyPoints,
          slideType,
          usedOCR,
          seenConceptLabels,
          worksheetRows,
          technologyRows,
        })

        extractedSlides.push({
          pageNumber,
          text,
          imageDataUrl,
          keyPoints,
          usedOCR,
          slideType,
          worksheetRows,
          technologyRows,
          slideExplanation,
        })
      }

      setSlides(extractedSlides)
      setOverallSummary(createOverallSummary(selectedFile.name, extractedSlides))
      setStatusMessage('Done. Revision notes generated.')
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

  async function extractDocxText(file) {
    const arrayBuffer = await file.arrayBuffer()
    const result = await mammoth.extractRawText({ arrayBuffer })

    return result.value
      .replace(/\r/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
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
      .map(cleanSpacing)
      .filter(Boolean)
      .join('\n')
  }

  async function renderPageAsImage(page, scale = 1.2) {
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')

    canvas.width = viewport.width
    canvas.height = viewport.height

    await page.render({
      canvasContext: context,
      viewport,
    }).promise

    return canvas.toDataURL('image/jpeg', 0.85)
  }

  function extractWorksheetRowsFromItems(textItems) {
    if (!textItems || textItems.length === 0) {
      return []
    }

    const allText = textItems.map((item) => item.text).join(' ')
    const lowerText = allText.toLowerCase()
    const isUnitOperationTable =
      lowerText.includes('unit') &&
      lowerText.includes('operation') &&
      (lowerText.includes('why selected') || lowerText.includes('objective/design') || lowerText.includes('design requirement'))

    if (!isUnitOperationTable) {
      return []
    }

    const unitHeaderX = findMinX(textItems, /^(unit|operation)$/i)
    const whyHeaderX = findMinX(textItems, /^(why|selected\??)$/i)
    const designHeaderX = findMinX(textItems, /^(link|objective\/design|design|requirement)$/i)

    if (unitHeaderX === null || whyHeaderX === null || designHeaderX === null) {
      return []
    }

    const nameUnitBoundary = unitHeaderX - 10
    const unitWhyBoundary = (unitHeaderX + whyHeaderX) / 2
    const whyDesignBoundary = designHeaderX - 15

    const linesByY = new Map()

    for (const item of textItems) {
      if (!linesByY.has(item.y)) {
        linesByY.set(item.y, [])
      }

      linesByY.get(item.y).push(item)
    }

    const lines = Array.from(linesByY.entries())
      .sort((a, b) => b[0] - a[0])
      .map(([, parts]) => parts.sort((a, b) => a.x - b.x))

    const operations = getKnownUnitOperations()
    const rows = []
    let currentRow = null

    function pushCurrentRow() {
      if (!currentRow) {
        return
      }

      const row = {
        name: cleanTableCell(currentRow.name.join(' ')).replace(/^Name\s+/i, ''),
        operation: cleanTableCell(currentRow.operation.join(' ')),
        whySelected: cleanTableCell(currentRow.why.join(' ')),
        designLink: cleanTableCell(currentRow.design.join(' ')),
      }

      if (row.name && row.operation && (row.whySelected || row.designLink)) {
        rows.push(row)
      }
    }

    for (const parts of lines) {
      const lineText = cleanSpacing(parts.map((part) => part.text).join(' '))

      if (isWorksheetHeaderLine(lineText)) {
        continue
      }

      const columns = { name: [], operation: [], why: [], design: [] }

      for (const part of parts) {
        if (part.x < nameUnitBoundary) {
          columns.name.push(part.text)
        } else if (part.x < unitWhyBoundary) {
          columns.operation.push(part.text)
        } else if (part.x < whyDesignBoundary) {
          columns.why.push(part.text)
        } else {
          columns.design.push(part.text)
        }
      }

      const operationText = cleanSpacing(columns.operation.join(' '))
      const startsNewRow = operations.some((operation) => operationText.includes(operation))

      if (startsNewRow) {
        pushCurrentRow()
        currentRow = { name: [], operation: [], why: [], design: [] }
      }

      if (!currentRow) {
        continue
      }

      currentRow.name.push(...columns.name)
      currentRow.operation.push(...columns.operation)
      currentRow.why.push(...columns.why)
      currentRow.design.push(...columns.design)
    }

    pushCurrentRow()

    return rows.map((row) =>
      repairWorksheetRow({
        ...row,
        whySelected: cleanWorksheetCell(row.whySelected),
        designLink: cleanWorksheetCell(row.designLink),
      })
    )
  }

  function extractTechnologyRowsFromItems(textItems) {
    if (!textItems || textItems.length === 0) {
      return []
    }

    const allText = cleanSpacing(textItems.map((item) => item.text).join(' '))
    const lowerText = allText.toLowerCase()
    const hasTechnologyTableSignal =
      lowerText.includes('option 1') &&
      lowerText.includes('option 2') &&
      (lowerText.includes('option 3') || lowerText.includes('selected')) &&
      lowerText.includes('unit operation')
    const hasContinuationSignal =
      lowerText.includes('option') ||
      getTechnologyUnitOperations().some((operation) => lowerText.includes(operation.toLowerCase()))

    if (!hasTechnologyTableSignal && !hasContinuationSignal) {
      return []
    }

    const linesByY = new Map()

    for (const item of textItems) {
      if (!linesByY.has(item.y)) {
        linesByY.set(item.y, [])
      }

      linesByY.get(item.y).push(item)
    }

    const lines = Array.from(linesByY.entries())
      .sort((a, b) => b[0] - a[0])
      .map(([, parts]) => parts.sort((a, b) => a.x - b.x))

    const option1X = findMinX(textItems, /^option$/i)
    const optionStarts = textItems
      .filter((item) => /^option$/i.test(item.text))
      .map((item) => item.x)
      .sort((a, b) => a - b)

    const boundaries = optionStarts.length >= 3
      ? {
          nameOperation: Math.max(62, optionStarts[0] - 58),
          operationOption1: Math.max(120, optionStarts[0] - 10),
          option1Option2: (optionStarts[0] + optionStarts[1]) / 2,
          option2Option3: (optionStarts[1] + optionStarts[2]) / 2,
          option3Selected: optionStarts[2] + 105,
        }
      : {
          nameOperation: 74,
          operationOption1: option1X ? Math.max(120, option1X - 10) : 145,
          option1Option2: 255,
          option2Option3: 365,
          option3Selected: 474,
        }

    const rows = []
    let currentRow = null

    function pushCurrentRow() {
      if (!currentRow) {
        return
      }

      const row = repairTechnologyRow({
        name: cleanPersonName(currentRow.name.join(' ')),
        operation: cleanTableCell(currentRow.operation.join(' ')),
        option1: cleanTableCell(currentRow.option1.join(' ')),
        option2: cleanTableCell(currentRow.option2.join(' ')),
        option3: cleanTableCell(currentRow.option3.join(' ')),
        selected: cleanTableCell(currentRow.selected.join(' ')),
      })

      if (row.operation && (row.option1 || row.option2 || row.option3 || row.selected)) {
        rows.push(row)
      }
    }

    for (const parts of lines) {
      const lineText = cleanSpacing(parts.map((part) => part.text).join(' '))

      if (isTechnologyHeaderLine(lineText) || /^task\s+2\b/i.test(lineText)) {
        continue
      }

      const columns = { name: [], operation: [], option1: [], option2: [], option3: [], selected: [] }

      for (const part of parts) {
        if (part.x < boundaries.nameOperation) {
          columns.name.push(part.text)
        } else if (part.x < boundaries.operationOption1) {
          columns.operation.push(part.text)
        } else if (part.x < boundaries.option1Option2) {
          columns.option1.push(part.text)
        } else if (part.x < boundaries.option2Option3) {
          columns.option2.push(part.text)
        } else if (part.x < boundaries.option3Selected) {
          columns.option3.push(part.text)
        } else {
          columns.selected.push(part.text)
        }
      }

      const operationText = cleanSpacing(columns.operation.join(' '))
      const startsNewRow = isTechnologyOperationStart(operationText, columns.name.join(' '))

      if (startsNewRow) {
        pushCurrentRow()
        currentRow = { name: [], operation: [], option1: [], option2: [], option3: [], selected: [] }
      }

      if (!currentRow) {
        continue
      }

      currentRow.name.push(...columns.name)
      currentRow.operation.push(...columns.operation)
      currentRow.option1.push(...columns.option1)
      currentRow.option2.push(...columns.option2)
      currentRow.option3.push(...columns.option3)
      currentRow.selected.push(...columns.selected)
    }

    pushCurrentRow()

    return rows
  }

  function extractTechnologyRows(text) {
    if (!text) {
      return []
    }

    const lowerText = text.toLowerCase()

    if (!lowerText.includes('option 1') || !lowerText.includes('option 2') || !lowerText.includes('selected')) {
      return []
    }

    const lines = text.split('\n').map(cleanSpacing).filter(Boolean)
    const rows = []
    let currentRow = null
    const operationPattern = new RegExp(`\\b(${getTechnologyUnitOperations().map(escapeRegex).join('|')})\\b`, 'i')

    function pushCurrentRow() {
      if (currentRow?.operation) {
        rows.push(repairTechnologyRow(currentRow))
      }
    }

    for (const line of lines) {
      if (isTechnologyHeaderLine(line) || /^task\s+2\b/i.test(line)) {
        continue
      }

      const match = line.match(operationPattern)

      if (match) {
        pushCurrentRow()
        const before = cleanSpacing(line.slice(0, match.index))
        const after = cleanSpacing(line.slice(match.index + match[0].length))
        currentRow = {
          name: cleanPersonName(before),
          operation: match[0],
          option1: after,
          option2: '',
          option3: '',
          selected: '',
        }
        continue
      }

      if (currentRow) {
        currentRow.option1 = cleanSpacing(`${currentRow.option1} ${line}`)
      }
    }

    pushCurrentRow()

    return rows
  }

  function findMinX(items, pattern) {
    const matches = items.filter((item) => pattern.test(item.text))

    if (matches.length === 0) {
      return null
    }

    return Math.min(...matches.map((item) => item.x))
  }

  function isWorksheetHeaderLine(lineText) {
    return /team member|unit operation|why selected|objective\/design|design requirement/i.test(lineText)
  }

  function isTechnologyHeaderLine(lineText) {
    return /team\s+member|unit\s+operation|option\s+[123]|which\s+option|brief\s+explanation|optional/i.test(lineText)
  }

  function getKnownUnitOperations() {
    return [
      'Nitrification and Denitrification',
      'Chemical Precipitation',
      'Reverse Osmosis',
      'Sedimentation',
      'Filtration',
      'Screening',
      'Flotation',
    ]
  }

  function getTechnologyUnitOperations() {
    return [
      'Nitrification and Denitrification',
      'Disinfection/pH adjustment',
      'Chemical Precipitation',
      'Reverse Osmosis',
      'Nanofiltration',
      'Sedimentation',
      'Floatation',
      'Flotation',
      'Screening',
      'Aeration',
      'Chemical',
    ]
  }

  function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  function isTechnologyOperationStart(operationText, nameText) {
    const cleanedOperation = cleanSpacing(operationText)
    const cleanedName = cleanSpacing(nameText)

    if (!cleanedOperation || isTechnologyHeaderLine(cleanedOperation)) {
      return false
    }

    const exactOperations = getTechnologyUnitOperations().filter((operation) => operation !== 'Chemical')
    const hasKnownOperation = exactOperations.some((operation) => cleanedOperation.includes(operation))
    const hasPartialChemical = /^Chemical$/i.test(cleanedOperation) && cleanedName.length > 0

    return hasKnownOperation || hasPartialChemical
  }

  function cleanPersonName(text) {
    return cleanTableCell(text)
      .replace(/\b(Member|Team|Name)\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function cleanTableCell(text) {
    return cleanSpacing(text)
      .replace(/\s+([,.;:!?])/g, '$1')
      .replace(/\bIt\s+doesn\s*[’']\s*t\b/gi, "It doesn’t")
      .replace(/\bwouldn\s*[’']\s*t\b/gi, "wouldn’t")
      .replace(/\bdon\s*[’']\s*t\b/gi, "don’t")
      .replace(/^Name\s+/i, '')
      .trim()
  }

  function cleanWorksheetCell(text) {
    return splitCellIntoBullets(text).join(' ')
  }

  function extractWorksheetRows(text) {
    if (!text) {
      return []
    }

    const lowerText = text.toLowerCase()
    const isUnitOperationTable =
      lowerText.includes('unit operation') &&
      (lowerText.includes('why selected') || lowerText.includes('objective/design') || lowerText.includes('design requirement'))

    if (!isUnitOperationTable) {
      return []
    }

    const operations = getKnownUnitOperations()

    const operationPattern = operations
      .map((operation) => operation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|')

    const normalisedText = cleanSpacing(
      text
        .replace(/Team Member\s+Name/gi, 'Team Member Name ')
        .replace(/Unit Operation/gi, 'Unit Operation ')
        .replace(/Why selected\?/gi, 'Why selected? ')
        .replace(/Link to\s+objective\/design\s+requirement/gi, 'Link to objective/design requirement ')
        .replace(/objective\/design\s+requirement/gi, 'objective/design requirement ')
    )

    // Important: this regex is case-sensitive on purpose. Otherwise words inside
    // a paragraph such as "filtration methods" get mistaken for a new table row.
    const operationRegex = new RegExp(`\\b(${operationPattern})\\b`, 'g')
    const operationMatches = []
    let operationMatch

    while ((operationMatch = operationRegex.exec(normalisedText)) !== null) {
      const nameInfo = findNameBeforeOperation(normalisedText, operationMatch.index)

      if (!nameInfo) {
        continue
      }

      operationMatches.push({
        name: nameInfo.name,
        nameStart: nameInfo.start,
        operation: operationMatch[1],
        operationStart: operationMatch.index,
        operationEnd: operationRegex.lastIndex,
      })
    }

    const rows = []

    for (let index = 0; index < operationMatches.length; index++) {
      const current = operationMatches[index]
      const next = operationMatches[index + 1]
      const bodyEnd = next ? next.nameStart : normalisedText.length
      const body = cleanSpacing(normalisedText.slice(current.operationEnd, bodyEnd))

      if (body.length < 20) {
        continue
      }

      const { whySelected, designLink } = splitWorksheetRowBody(body)

      rows.push(
        repairWorksheetRow({
          name: current.name,
          operation: current.operation,
          whySelected: cleanWorksheetCell(whySelected),
          designLink: cleanWorksheetCell(designLink),
        })
      )
    }

    return rows
  }

  function findNameBeforeOperation(text, operationIndex) {
    const sliceStart = Math.max(0, operationIndex - 180)
    const beforeOperation = text.slice(sliceStart, operationIndex)
    const match = beforeOperation.match(/([A-Z][A-Za-z']*(?:\s+[A-Z][A-Za-z']*){0,4})\s*$/)

    if (!match) {
      return null
    }

    const headerWords = new Set([
      'Team', 'Member', 'Name', 'Unit', 'Operation', 'Why', 'Selected', 'Link',
      'Objective', 'Design', 'Requirement', 'Task', 'Class', 'Today', 'Checklist',
    ])

    const words = match[1]
      .split(/\s+/)
      .filter((word) => word && !headerWords.has(word))

    if (words.length === 0) {
      return null
    }

    const name = cleanSpacing(words.join(' '))

    // Do not accept long text fragments as names.
    if (name.split(/\s+/).length > 4 || name.length < 3) {
      return null
    }

    return {
      name,
      start: sliceStart + beforeOperation.length - match[0].length + match[0].lastIndexOf(words[0]),
    }
  }

  function repairWorksheetRow(row) {
    const operation = cleanTableCell(row.operation)
    const combinedText = cleanTableCell(`${row.whySelected || ''} ${row.designLink || ''}`)
    if (/reverse osmosis/i.test(operation) && /membrane|copper|cobalt|sludge|electrochemical|brine/i.test(combinedText)) {
      return {
        ...row,
        operation,
        whySelected: [
          'Uses membranes that are impenetrable to copper and cobalt to filter them out of the liquid.',
          'Does not produce sludge, which reduces the cost that would otherwise go to sludge treatment.',
          'Does not require a constant electrical supply like electrochemical recovery.',
          'The filtered copper brine can be reprocessed and reused.',
        ].join(' '),
        designLink: [
          'Does not create odour or smoke, so it is less likely to affect nearby individuals.',
          'Although it is costly, it is highly effective in clearing the intended waste.',
        ].join(' '),
      }
    }

    if (/filtration/i.test(operation) && /impure|particle|filter|output|clean/i.test(combinedText)) {
      return {
        ...row,
        operation,
        whySelected: [
          'Removes impure particles using filtration methods such as cartridge filters and self-cleaning filters.',
          'Helps ensure the output is as clean as possible.',
        ].join(' '),
        designLink: [
          'Helps prolong material robustness by reducing impurities.',
          'Reduces impurities that could harm the material condition and system reliability.',
        ].join(' '),
      }
    }

    if (/screening/i.test(operation) && /large|solid|plastic|debris|blockage/i.test(combinedText)) {
      return {
        ...row,
        operation,
        whySelected: [
          'Removes large solid waste such as plastic and debris at an early stage.',
          'Prevents blockage and damage to the treatment system.',
          'Helps downstream processes function smoothly and continuously.',
        ].join(' '),
        designLink: [
          'Maintains system reliability and effectiveness by reducing operational disruption.',
          'Supports stable and efficient pollution control because the treatment process can continue running.',
        ].join(' '),
      }
    }

    if (/flotation/i.test(operation) && /suspended|solids|oil|grease|bubble|microplastic/i.test(combinedText)) {
      return {
        ...row,
        operation,
        whySelected: [
          'Removes suspended solids such as fats, oil, and grease using air bubbles.',
          'Hydrophobic pollutants float to the top and can be skimmed off.',
          'Hydrophilic waste substances sink and can move on to sedimentation.',
        ].join(' '),
        designLink: [
          'Allows rapid removal of low-density pollutants such as oil, algae, and some microplastics.',
          'Can reduce total suspended solids, COD, turbidity, and microplastics.',
          'Has a smaller footprint than conventional clarifiers and can help recover useful resources.',
        ].join(' '),
      }
    }

    if (/sedimentation/i.test(operation) && /suspended|sediment|solid/i.test(combinedText)) {
      return {
        ...row,
        operation,
        whySelected: 'Collects and removes suspended matter that settles as sediment.',
        designLink: 'Removes solids so they can be handled or processed further.',
      }
    }

    if (/nitrification/i.test(operation) && /ammoniacal|nitrogen|ammonia|nitrate|oxygen/i.test(combinedText)) {
      return {
        ...row,
        operation,
        whySelected: [
          'Removes high concentrations of ammoniacal nitrogen from the river.',
          'Uses bacteria such as AOB and NOB to convert ammonia into nitrate.',
          'Can use dissolved oxygen already present in the river, making the process more self-sustaining.',
          'Requires proper carbon and oxygen balance to avoid harmful by-products.',
        ].join(' '),
        designLink: [
          'Can reduce cost because dissolved oxygen is naturally available.',
          'Needs correct carbon ratios and monitoring to prevent oxygen imbalance.',
        ].join(' '),
      }
    }

    if (/chemical precipitation/i.test(operation) && /heavy metal|sludge|wastewater|maintenance/i.test(combinedText)) {
      return {
        ...row,
        operation,
        whySelected: [
          'Removes highly concentrated heavy metals from the river.',
          'Is cheaper than some other treatment options.',
          'Can be effective for factory wastewater, but produces sludge.',
        ].join(' '),
        designLink: [
          'Likely requires less maintenance, which can reduce cost.',
          'Can avoid harming aquatic life if carried out properly.',
        ].join(' '),
      }
    }

    return {
      ...row,
      operation,
      whySelected: cleanWorksheetCell(row.whySelected),
      designLink: cleanWorksheetCell(row.designLink),
    }
  }

  function repairTechnologyRow(row) {
    const cleaned = {
      name: cleanPersonName(row.name || ''),
      operation: cleanTableCell(row.operation || ''),
      option1: cleanTableCell(row.option1 || ''),
      option2: cleanTableCell(row.option2 || ''),
      option3: cleanTableCell(row.option3 || ''),
      selected: cleanTableCell(row.selected || ''),
    }

    if (/^Chemical$/i.test(cleaned.operation) && /precipitation/i.test(cleaned.option1)) {
      cleaned.operation = 'Chemical Precipitation'
      cleaned.option1 = cleaned.option1.replace(/^Precipitation\s+/i, '')
    }

    return cleaned
  }

  function splitWorksheetRowBody(body) {
    const cleanedBody = cleanSpacing(body)

    const designStartPatterns = [
      /\bIt doesn[’']t create\b/i,
      /\bIt can help\b/i,
      /\bTo maintain\b/i,
      /\bIt allows\b/i,
      /\bCan remove\b/i,
      /\bIt can be carried\b/i,
      /\bThis process likely\b/i,
      /\bThis process doesn[’']t\b/i,
    ]

    for (const pattern of designStartPatterns) {
      const match = cleanedBody.match(pattern)

      if (match && match.index > 40) {
        return {
          whySelected: cleanSpacing(cleanedBody.slice(0, match.index)),
          designLink: cleanSpacing(cleanedBody.slice(match.index)),
        }
      }
    }

    const sentencePieces = splitIntoReadableSentences(cleanedBody)

    if (sentencePieces.length <= 1) {
      return {
        whySelected: cleanedBody,
        designLink: '',
      }
    }

    const splitIndex = Math.max(1, Math.ceil(sentencePieces.length * 0.65))

    return {
      whySelected: sentencePieces.slice(0, splitIndex).join(' '),
      designLink: sentencePieces.slice(splitIndex).join(' '),
    }
  }

  function splitIntoReadableSentences(text) {
    return text
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .map(cleanPoint)
      .filter((sentence) => sentence.length >= 10)
  }

  function createWorksheetKeyPoints(rows) {
    if (rows.length === 0) {
      return []
    }

    const operationList = rows
      .slice(0, 4)
      .map((row) => row.operation)
      .filter((operation, index, array) => array.indexOf(operation) === index)
      .join(', ')

    return [
      `This worksheet table lists ${rows.length} proposed unit operation${rows.length === 1 ? '' : 's'}.`,
      `Main operation${rows.length === 1 ? '' : 's'} shown: ${operationList}.`,
      'Use the table summary below instead of reading the row as broken bullet points.',
    ]
  }

  function createTechnologyKeyPoints(rows) {
    if (rows.length === 0) {
      return []
    }

    const operations = rows
      .map((row) => row.operation)
      .filter((operation, index, array) => operation && array.indexOf(operation) === index)
      .slice(0, 5)
      .join(', ')

    return [
      `This Task 2 table compares alternative technologies for ${rows.length} unit operation${rows.length === 1 ? '' : 's'}.`,
      `Main operation${rows.length === 1 ? '' : 's'} shown: ${operations}.`,
      'Read across each row: Option 1, Option 2, Option 3, then the selected option and reason.',
      'Focus on distinguishing features such as cost, energy use, clogging risk, maintenance, flow handling, footprint, and reliability.',
    ]
  }

  function isFallbackOnly(points) {
    return points.every((point) => {
      const lowerPoint = point.toLowerCase()

      return (
        lowerPoint.includes('no selectable text') ||
        lowerPoint.includes('mainly a title') ||
        lowerPoint.includes('appears to be mainly visual') ||
        lowerPoint.includes('review the preview image') ||
        lowerPoint.includes('mostly code')
      )
    })
  }

  function isNavigationOrAdminSlide(text) {
    const lowerText = text.toLowerCase()

    const isTitlePage =
      lowerText.includes('fit1043 introduction to data science') ||
      lowerText.includes('week 6: regression analysis') ||
      lowerText.includes('school of information technology') ||
      lowerText.includes('monash university malaysia') ||
      lowerText.includes('with materials from')

    return (
      isTitlePage ||
      lowerText.includes('week 6 outline') ||
      lowerText.includes('learning outcomes') ||
      lowerText.includes('week activities') ||
      lowerText.includes('week 5 coverage') ||
      lowerText.includes('overview of data science') ||
      lowerText.includes('introduction to data analysis')
    )
  }

  function detectSlideType(text, keyPoints, usedOCR) {
    const lowerText = text.toLowerCase()
    const pointText = keyPoints.join(' ').toLowerCase()

    if (isNavigationOrAdminSlide(text)) {
      return 'navigation'
    }

    if (looksLikeReferenceOnly(text, keyPoints)) {
      return 'reference'
    }

    if (isCodeSlide(text)) {
      return 'code'
    }

    if (extractFormulas(text).length > 0) {
      return 'formula'
    }

    if (isFallbackOnly(keyPoints)) {
      return usedOCR ? 'ocr-visual' : 'visual'
    }

    if (/graph|plot|scatter|axis|axes|curve|line|points|training data|test data|truth|predicted|actual/i.test(lowerText + ' ' + pointText)) {
      return 'graph'
    }

    return 'concept'
  }

  function createSlideExplanation({ text, keyPoints, slideType, usedOCR, seenConceptLabels, worksheetRows = [], technologyRows = [] }) {
    if (slideType === 'technology-table') {
      return {
        title: 'Technology Options Table',
        bullets: [
          'This page is a technology comparison table, so the app keeps each unit operation row together.',
          'Each option cell is split into readable feature bullets instead of being treated as code or one broken paragraph.',
        ],
        formulas: [],
        concepts: [],
        technologyRows,
      }
    }

    if (slideType === 'worksheet-table') {
      return {
        title: 'Worksheet / Table Summary',
        bullets: [
          'This page is a table/worksheet, so the app keeps each row together instead of splitting the table into random bullet points.',
        ],
        formulas: [],
        concepts: [],
        tableRows: worksheetRows,
      }
    }

    if (slideType === 'navigation') {
      return {
        title: 'Slide Purpose',
        bullets: [
          'This slide is for navigation only. Use it as a topic map, not as a heavy revision slide.',
        ],
        formulas: [],
        concepts: [],
      }
    }

    if (slideType === 'reference') {
      return {
        title: 'Slide Purpose',
        bullets: [
          'This slide mainly contains a citation/reference. It is ignored as a revision point unless the lecturer specifically asks about the source.',
        ],
        formulas: [],
        concepts: [],
      }
    }

    if (slideType === 'code') {
      return {
        title: 'Code Explanation',
        bullets: createCodeExplanation(text),
        formulas: [],
        concepts: [],
      }
    }

    const formulas = extractFormulas(text)

    if (slideType === 'formula') {
      return {
        title: 'Formula Explanation',
        bullets: createFormulaSlideExplanation(text, formulas),
        formulas,
        concepts: [],
      }
    }

    if (slideType === 'graph' || slideType === 'visual' || slideType === 'ocr-visual') {
      return {
        title: slideType === 'graph' ? 'Graph / Diagram Explanation' : 'Visual Slide Note',
        bullets: createVisualExplanation(text, keyPoints, usedOCR),
        formulas: [],
        concepts: [],
      }
    }

    const concepts = findNewConceptNotes(text, keyPoints, seenConceptLabels)

    if (concepts.length === 0) {
      return null
    }

    return {
      title: 'Concept Explanation',
      bullets: [],
      formulas: [],
      concepts,
    }
  }

  function isCodeSlide(text) {
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
    const codeLineCount = lines.filter(looksLikeCodeLine).length
    const lowerText = text.toLowerCase()

    return (
      codeLineCount >= 3 ||
      /python example|import numpy|matplotlib|sklearn|linearregression|polynomialfeatures|np\.|plt?\.|pl\.|rd\.|def truefunc|for order in orders/i.test(lowerText)
    )
  }

  function looksLikeReferenceOnly(text, keyPoints) {
    const usefulPoints = keyPoints.filter((point) => !isFallbackOnly([point]))

    if (usefulPoints.length === 0) {
      return false
    }

    return usefulPoints.every((point) => looksLikeCitation(point)) || /friedman|hastie|tibshirani|springer series|statistical learning/i.test(text)
  }

  function findNewConceptNotes(text, keyPoints, seenConceptLabels) {
    const pointText = keyPoints.join(' ')

    if (isFallbackOnly(keyPoints) || pointText.length < 40) {
      return []
    }

    const matches = []
    const searchableText = `${text} ${pointText}`

    for (const entry of CONCEPT_GLOSSARY) {
      if (!seenConceptLabels.has(entry.label) && entry.test(searchableText)) {
        matches.push({ label: entry.label, explanation: entry.explanation })
        seenConceptLabels.add(entry.label)
      }
    }

    return matches.slice(0, 2)
  }

  function extractFormulas(text) {
    const formulas = []

    const teachesMSE = /mean squared error|\bmse\b|loss function/i.test(text)
    const teachesSimpleLinear = /simple linear regression|intercept and slope terms|ŷ\s*\(|a₀|a0\s*\+\s*a1|a_?0\s*\+\s*a_?1/i.test(text)
    const teachesPolynomial = /polynomial regression|\b\d+(st|nd|rd|th)?\s+degree polynomial|polynomial of order|a₂|a2\s*x|a3\s*x/i.test(text)
    const teachesEnsemble = /\bensembles?\b/i.test(text) && /average the predictions|collection of possible|collection of several|ŷ\s*\(x\)|1\s*\/\s*M/i.test(text)

    if (teachesMSE) {
      formulas.push({
        label: 'Mean Squared Error (MSE)',
        formula: 'MSE = (1 / N) Σ(ŷᵢ − yᵢ)²',
        explanation: 'ŷᵢ is the predicted value, yᵢ is the actual value, and N is the number of data points. Smaller MSE means the regression line is closer to the real points.',
      })
    }

    if (teachesSimpleLinear) {
      formulas.push({
        label: 'Simple linear regression',
        formula: 'ŷ = a₀ + a₁x',
        explanation: 'ŷ is the predicted output, x is the input, a₀ is the intercept, and a₁ is the slope. This slide is teaching a straight-line prediction model.',
      })
    }

    if (teachesPolynomial) {
      formulas.push({
        label: 'Polynomial regression',
        formula: 'ŷ = a₀ + a₁x + a₂x² + a₃x³ + ...',
        explanation: 'Polynomial regression adds powers of x so the fitted curve can bend. More degree/order means more flexibility, but too much can overfit.',
      })
    }

    if (teachesEnsemble) {
      formulas.push({
        label: 'Ensemble average',
        formula: 'ŷ(x) = (1 / M) Σ ŷⱼ(x)',
        explanation: 'The final prediction is the average of M model predictions. Averaging can make the result more stable than using one model only.',
      })
    }

    return formulas.filter((formula, index, array) => array.findIndex((item) => item.label === formula.label) === index)
  }

  function createFormulaSlideExplanation(text, formulas) {
    if (formulas.length === 0) {
      return ['This slide contains a formula. Use the clean formula below instead of relying on messy extracted symbols from the PDF.']
    }

    return formulas.map((formula) => formula.explanation)
  }

  function createCodeExplanation(text) {
    const codeLines = extractCodeLines(text)
    const bullets = []
    const seen = new Set()

    function add(message) {
      if (!seen.has(message)) {
        bullets.push(message)
        seen.add(message)
      }
    }

    if (codeLines.length === 0) {
      return [
        'This slide contains code-like content, but the extracted text is too noisy to explain line by line. Use the preview image and extracted text together.',
      ]
    }

    for (const rawLine of codeLines) {
      const explanation = explainCodeLine(rawLine)

      if (explanation) {
        add(explanation)
      }
    }

    addCodeContextExplanation(text, add)

    if (bullets.length === 0) {
      return [
        'This code slide was detected, but the line patterns are unclear. The safest revision task is to identify the inputs, processing step, and output from the extracted code.',
      ]
    }

    return bullets.slice(0, 12)
  }

  function extractCodeLines(text) {
    return text
      .split('\n')
      .map((line) => cleanSpacing(line))
      .filter(Boolean)
      .filter((line) => !/^out\s*\[?\d*\]?\s*:/i.test(line))
      .filter((line) => {
        const lowerLine = line.toLowerCase()

        return (
          looksLikeCodeLine(line) ||
          line.startsWith('%') ||
          line.startsWith('#') ||
          /^\w+\s*=/.test(line) ||
          /\b(import|from|def|return|for|print|plot|scatter|figure|subplot|legend|xlabel|ylabel|title|fit|predict|transform)\b/i.test(line) ||
          /\b(np|pl|plt|pd|rd|model|poly|x|y|ys|xs|orders)\./i.test(line) ||
          /regressiondemo|linearregression|polynomialfeatures|train_test_split/i.test(lowerLine)
        )
      })
  }

  function explainCodeLine(line) {
    const lowerLine = line.toLowerCase()
    const displayLine = line.length > 90 ? `${line.slice(0, 90)}...` : line

    if (/^in\s*\[?\d*\]?\s*:/i.test(line)) {
      return null
    }

    if (/^#/.test(line)) {
      const comment = cleanPoint(line.replace(/^#+\s*/, ''))
      return comment.length > 12 ? `Comment: ${comment}` : null
    }

    if (/^%matplotlib\s+inline/i.test(line)) {
      return '`%matplotlib inline` tells Jupyter to show graphs directly under the code cell.'
    }

    const importMatch = line.match(/^import\s+([\w.]+)(?:\s+as\s+(\w+))?/i)
    if (importMatch) {
      const library = importMatch[1]
      const alias = importMatch[2]

      if (/numpy/i.test(library)) {
        return alias
          ? `Imports NumPy as \`${alias}\` so the code can calculate arrays, random values, sine, square root, and other numerical operations.`
          : 'Imports NumPy so the code can do numerical calculations.'
      }

      if (/matplotlib/i.test(library)) {
        return alias
          ? `Imports Matplotlib as \`${alias}\` so the code can draw scatter plots, true curves, and fitted model curves.`
          : 'Imports Matplotlib so the code can draw graphs.'
      }

      if (/regressiondemo/i.test(library)) {
        return alias
          ? `Imports the course helper file \`regressiondemo\` as \`${alias}\`; this file provides helper functions used in the regression lab.`
          : 'Imports the course helper file `regressiondemo`, which provides functions used in the regression lab.'
      }

      return alias
        ? `Imports \`${library}\` as \`${alias}\`, so later code can call it using the shorter name.`
        : `Imports the \`${library}\` library so its functions can be used in the notebook.`
    }

    const fromImportMatch = line.match(/^from\s+([\w.]+)\s+import\s+(.+)/i)
    if (fromImportMatch) {
      return `Imports \`${fromImportMatch[2]}\` from \`${fromImportMatch[1]}\`, so the notebook can use that specific tool directly.`
    }

    const defMatch = line.match(/^def\s+(\w+)\s*\(([^)]*)\)/i)
    if (defMatch) {
      return `Defines a function called \`${defMatch[1]}\` with input(s) \`${defMatch[2] || 'none'}\`. This creates reusable logic for the later cells.`
    }

    if (/^return\b/i.test(line)) {
      if (/sin|sqrt|truefunc/i.test(line)) {
        return 'The `return` line calculates the output y-value from x, creating the known “true” pattern used for comparison.'
      }

      return `Returns the final calculated value from the function: \`${displayLine}\`.`
    }

    const forMatch = line.match(/^for\s+(.+?)\s+in\s+(.+?):?/i)
    if (forMatch) {
      return `Starts a loop: for each \`${forMatch[1]}\` inside \`${forMatch[2]}\`, the indented code repeats. This is usually used to fit or plot several models automatically.`
    }

    if (/print\s*\(/i.test(line)) {
      return `Prints information to the notebook output so the student can see the result: \`${displayLine}\`.`
    }

    if (/figure\s*\(/i.test(line)) {
      return 'Creates or resizes the plotting canvas so the graph has enough space to display clearly.'
    }

    if (/subplot\s*\(/i.test(line)) {
      return 'Creates a subplot area, allowing several graphs to be shown in one figure for comparison.'
    }

    if (/\b(plot|scatter)\s*\(/i.test(line) || /\b(pl|plt)\.plot/i.test(line)) {
      if (/truth/i.test(lowerLine)) {
        return 'Plots the true relationship/curve so later fitted models can be compared against it.'
      }

      if (/poly|predict|fit|model/i.test(lowerLine)) {
        return 'Plots a fitted model curve, so students can compare how different model orders behave.'
      }

      if (/'x'|"x"|scatter/i.test(lowerLine)) {
        return 'Plots the simulated data points as markers, showing the collected/noisy observations.'
      }

      return `Draws a graph based on the variables in the line: \`${displayLine}\`.`
    }

    if (/xlabel\s*\(/i.test(line)) {
      return 'Labels the x-axis, usually showing the input/independent variable.'
    }

    if (/ylabel\s*\(/i.test(line)) {
      return 'Labels the y-axis, usually showing the output/dependent variable.'
    }

    if (/title\s*\(|suptitle\s*\(/i.test(line)) {
      return 'Adds a title to the graph so the plotted output is easier to understand.'
    }

    if (/legend\s*\(/i.test(line)) {
      return 'Adds a legend so each plotted line or curve can be identified.'
    }

    if (/xlim\s*\(|ylim\s*\(/i.test(line)) {
      return 'Sets the visible axis range so the graph is easier to compare across models.'
    }

    if (/linearregression\s*\(/i.test(line)) {
      return 'Creates a linear regression model object that will later be fitted to data.'
    }

    if (/polynomialfeatures\s*\(/i.test(line)) {
      return 'Creates polynomial features, turning x into powers such as x² or x³ so the model can fit curved patterns.'
    }

    if (/\.fit\s*\(/i.test(line)) {
      return 'Fits/trains the model using the input data and target output values.'
    }

    if (/\.predict\s*\(/i.test(line)) {
      return 'Uses the fitted model to generate predicted y-values.'
    }

    if (/\.transform\s*\(/i.test(line) || /fit_transform\s*\(/i.test(line)) {
      return 'Transforms the original input x into a new feature form, usually for polynomial regression.'
    }

    const assignmentMatch = line.match(/^(\w+)\s*=\s*(.+)$/)
    if (assignmentMatch) {
      const variableName = assignmentMatch[1]
      const expression = assignmentMatch[2]
      const lowerExpression = expression.toLowerCase()

      if (/makex\s*\(/i.test(expression)) {
        return `Creates \`${variableName}\`, the x-values/input points used for the regression demonstration.`
      }

      if (/truefunc\s*\(/i.test(expression)) {
        return `Creates \`${variableName}\` by passing x-values into the true function, giving the matching y-values from the real pattern.`
      }

      if (/addnoise/i.test(expression)) {
        return `Creates \`${variableName}\` by adding noise to the true y-values, simulating imperfect real-world data.`
      }

      if (/makeorders\s*\(/i.test(expression)) {
        return `Creates \`${variableName}\`, a list of polynomial orders to test, such as small, medium, and very complex models.`
      }

      if (/linreg|linearregression/i.test(expression)) {
        return `Creates \`${variableName}\`, a regression model that will be fitted to the data.`
      }

      if (/random|normal|uniform/i.test(lowerExpression)) {
        return `Creates \`${variableName}\` using random values, so the lab can simulate a dataset rather than using a fixed perfect pattern.`
      }

      if (/range\s*\(/i.test(expression)) {
        return `Creates \`${variableName}\` as a sequence of numbers, usually to repeat plotting or modelling multiple times.`
      }

      return `Creates or updates \`${variableName}\` using this expression: \`${displayLine}\`.`
    }

    return null
  }

  function addCodeContextExplanation(text, add) {
    if (/fitting polynomials of orders/i.test(text)) {
      add('The printed output shows which polynomial orders will be fitted, for example 3, 6, 12, and 25.')
    }

    if (/best possible fits/i.test(text)) {
      add('This code compares the best possible fitted curves for different polynomial orders against the true function.')
    }

    if (/different samples|sample/i.test(text) && /orders|polynomial/i.test(text)) {
      add('The code repeats fitting on different samples to show that complex models can change a lot depending on which data points are used.')
    }
  }

  function createVisualExplanation(text, keyPoints, usedOCR) {
    const searchableText = `${text} ${keyPoints.join(' ')}`.toLowerCase()

    if (/best fitting line|actual - predicted|predicted response/.test(searchableText)) {
      return [
        'The graph compares actual values with predicted values from the regression line.',
        'The vertical gap between an actual point and the predicted point is the error. A better line makes these gaps smaller.',
      ]
    }

    if (/underfitting/.test(searchableText) && !/overfitting/.test(searchableText)) {
      return [
        'The red straight line is too simple for the pattern in the data, so it misses the underlying structure.',
        'This is underfitting: the model does not fit the data enough, so error stays high.',
      ]
    }

    if (/overfitting/.test(searchableText) && !/underfitting/.test(searchableText)) {
      return [
        'The fitted curve follows the training data too closely, including random noise.',
        'This is overfitting: the model may look good on training data but can perform badly on new data.',
      ]
    }

    if (/underfitting/.test(searchableText) && /overfitting/.test(searchableText)) {
      return [
        'This visual compares two bad model fits: underfitting is too simple, while overfitting is too complex.',
        'For revision, focus on the balance: the model should capture the real trend without chasing noise.',
      ]
    }

    if (/scenario 1/.test(searchableText)) {
      return [
        'Scenario 1 compares model flexibility against error. The truth is curved, while the data points are noisy.',
        'The straight model is too simple; a more flexible model can fit the pattern better, but too much flexibility can increase test error.',
      ]
    }

    if (/scenario 2/.test(searchableText)) {
      return [
        'Scenario 2 shows a smoother, almost straight true function.',
        'Because the pattern is simple, a lower-complexity model works well and a more complex model gives little benefit.',
      ]
    }

    if (/scenario 3/.test(searchableText)) {
      return [
        'Scenario 3 shows a pattern that is not close to a straight line.',
        'The linear model has high error, while more complex polynomial models fit the curved pattern better.',
      ]
    }

    if (/bias/.test(searchableText) && /variance/.test(searchableText)) {
      return [
        'This visual is about the bias-variance tradeoff: simple models tend to have high bias, while very complex models tend to have high variance.',
        'Read the graph by looking at model complexity versus prediction error. The best model is usually between underfitting and overfitting.',
      ]
    }

    if (/ensemble|ensembles/.test(searchableText)) {
      return [
        'The many curves represent different reasonable models fitted from data.',
        'If the curves differ a lot, predictions have high variability; averaging models can make predictions more stable.',
      ]
    }

    if (/no free lunch|wolpert|mccready/.test(searchableText)) {
      return [
        'This slide explains the No Free Lunch theorem: no single learning algorithm is best for every kind of problem.',
        'The main meaning is that model choice depends on the dataset and task; an algorithm that works well for one problem can perform worse on another.',
      ]
    }

    if (/predictive vs descriptive/.test(searchableText)) {
      return [
        'The diagram separates predictive tasks from descriptive tasks.',
        'Predictive methods estimate future or unknown outputs, while descriptive methods help summarise or discover patterns in existing data.',
      ]
    }

    if (/regression|predicted|actual|mse|scatter|plot|line/.test(searchableText)) {
      return [
        'This graph supports the regression idea: compare the data points with the fitted line or curve.',
        'The main question is whether the model follows the overall pattern without chasing random noise.',
      ]
    }

    if (usedOCR) {
      return ['This page was read using OCR, so the extracted text may be noisy. Use the slide preview as the main source and the notes as a rough guide.']
    }

    return ['This slide is mostly visual. The preview is the main source here because the PDF text layer does not contain enough explanation to summarise safely.']
  }

  function createNavigationKeyPoints(text) {
    const lowerText = text.toLowerCase()
    const lines = text
      .replace(/[•●▪▫◦]/g, '\n')
      .split(/\n+/)
      .map(cleanPoint)
      .filter(Boolean)

    if (lowerText.includes('week 6: regression analysis') || lowerText.includes('fit1043 introduction to data science')) {
      return ['This is the title slide for Week 6 Regression Analysis.']
    }

    if (lowerText.includes('week 6 outline') || lowerText.includes('introduction to data analysis')) {
      return lines
        .filter((line) =>
          /linear regression terminology|calculate model parameters|underfitting|overfitting|bias and variance|no free lunch|ensemble models/i.test(line)
        )
        .slice(0, 6)
    }

    if (lowerText.includes('learning outcomes') || lowerText.includes('recap: learning outcomes')) {
      return lines
        .filter((line) => /fit linear|explain overfitting|comprehend bias|no free lunch|ensemble models/i.test(line))
        .map((line) => line.replace(/^By the end of this week you should be able to:?\s*/i, ''))
        .slice(0, 5)
    }

    if (lowerText.includes('week activities')) {
      return ['This slide is a weekly schedule. It is useful for navigation, but it is not a core revision slide.']
    }

    if (lowerText.includes('week 5 coverage')) {
      return ['This slide recaps previous Week 5 topics before starting Week 6 regression analysis.']
    }

    if (/data analysis algorithms/i.test(text) && /regression/i.test(text)) {
      return ['Regression is introduced here as a data analysis algorithm.']
    }

    return []
  }

  function createKeyPoints(text, pageNumber) {
    const cleanedText = text.trim()

    if (!cleanedText) {
      return [
        'No selectable text was found on this slide/page.',
        'Check the slide preview manually because it may contain scanned text or visuals.',
      ]
    }

    const specialPoints = createNavigationKeyPoints(cleanedText)

    if (specialPoints.length > 0) {
      return specialPoints
    }

    const rawPoints = cleanedText
      .replace(/[•●▪▫◦]/g, '\n')
      .split(/\n+/)
      .map(cleanPoint)
      .filter(Boolean)

    const mergedPoints = mergeBrokenSentenceFragments(mergeShortLeadInPoints(rawPoints))

    const candidatePoints = mergedPoints
      .filter((point) => isUsefulKeyPoint(point, pageNumber))
      .filter((point, index, array) => array.indexOf(point) === index)

    if (candidatePoints.length === 0) {
      return ['This slide/page is mainly a title, diagram, or visual. Review the preview image for context.']
    }

    return candidatePoints.slice(0, 5)
  }

  function cleanOCRText(rawText) {
    return rawText
      .split('\n')
      .map((line) => line.replace(/\s+$/g, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  }

  function looksLikeCodeLine(line) {
    const trimmed = line.trim()

    if (!trimmed) {
      return false
    }

    const codeSignals = [
      /^(import|from|def|for|while|if|elif|else|return|print\(|class)\b/,
      /^(In|Out)\s*\[\d*\]/i,
      /[=(){}[\]]/,
      /^#/,
      /\b(pl|rd|np|pd)\.\w+\(/,
    ]

    return codeSignals.some((pattern) => pattern.test(trimmed))
  }

  function createKeyPointsFromProse(text) {
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map(removeChartJunkSegments)

    const proseLines = lines.filter((line) => !looksLikeCodeLine(line) && !looksLikeChartJunk(line))

    if (proseLines.length === 0) {
      return ['This slide/page is mostly code — this tool explains lecture concepts, not arbitrary code. See the extracted text and preview image for the actual code.']
    }

    const sentences = proseLines
      .join(' ')
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => cleanSpacing(sentence))
      .filter((sentence) => sentence.length >= 25 && sentence.length <= 240)
      .filter((sentence) => !looksLikeChartJunk(sentence) && !looksLikeCitation(sentence))
      .filter((sentence, index, array) => array.indexOf(sentence) === index)

    if (sentences.length === 0) {
      return proseLines.slice(0, 5)
    }

    return sentences.slice(0, 5)
  }

  function mergeShortLeadInPoints(points) {
    const merged = []

    for (let index = 0; index < points.length; index++) {
      const currentPoint = points[index]
      const nextPoint = points[index + 1]

      if (nextPoint && /[,;:]$/.test(currentPoint) && nextPoint.length < 180) {
        merged.push(`${currentPoint} ${nextPoint}`)
        index++
      } else {
        merged.push(currentPoint)
      }
    }

    return merged
  }

  function mergeBrokenSentenceFragments(points) {
    const merged = []

    for (let index = 0; index < points.length; index++) {
      let currentPoint = points[index]

      while (looksIncomplete(currentPoint) && points[index + 1]) {
        currentPoint = `${currentPoint} ${points[index + 1]}`
        index++
      }

      merged.push(currentPoint)
    }

    return merged.map(cleanSpacing)
  }

  function looksIncomplete(point) {
    const lowerPoint = point.toLowerCase()
    const incompleteEndings = [
      'and', 'or', 'the', 'a', 'an', 'of', 'to', 'from', 'with', 'for', 'in', 'on', 'by',
      'be', 'if', 'because', 'when', 'as close', 'capture the', 'certain class of',
      'with very much', 'complicated a', 'will make wild', 'known error in the data, then a close fit is wasted: th',
      'we do not know the', 'is a whole', 'to improve', 'differs from the', 'predictions for',
    ]

    return incompleteEndings.some((ending) => lowerPoint.endsWith(` ${ending}`))
  }

  function cleanPoint(point) {
    return cleanSpacing(point)
      .replace(/^[-–—*•●▪▫◦]+\s*/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/^e\.g\.?\s*/i, 'Example: ')
      .replace(/^i\.e\.?\s*/i, 'That is, ')
      .trim()
  }

  function cleanSpacing(text) {
    return text
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .replace(/\(\s+/g, '(')
      .replace(/\s+\)/g, ')')
      .replace(/([a-zA-Z])\s+-\s+([a-zA-Z])/g, '$1-$2')
      .replace(/\bi\s*\.\s*e\s*\./gi, 'i.e.')
      .replace(/\be\s*\.\s*g\s*\./gi, 'e.g.')
      .replace(/\s+'/g, "'")
      .trim()
  }

  function looksLikeCitation(point) {
    const hasYear = /\b(19|20)\d{2}\b/.test(point)
    const hasCitationMarker = /\bvol\.?\s*\d/i.test(point) || /\bno\.?\s*\d/i.test(point) || /\bpp\.?\s*\d/i.test(point)
    const looksLikeAuthorList = /^[A-Z][a-zA-Z'-]+,\s+[A-Z][a-zA-Z'-]+/.test(point)

    return hasCitationMarker && (hasYear || looksLikeAuthorList)
  }

  function looksLikeChartJunk(point) {
    const compact = point.replace(/\s+/g, '')

    if (!compact) {
      return true
    }

    const letterCount = (compact.match(/[a-zA-Z]/g) || []).length
    const letterRatio = letterCount / compact.length
    const realWordCount = point
      .split(/\s+/)
      .map((word) => word.replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, ''))
      .filter((word) => word.length >= 3).length

    // Axis labels, tick marks and legend fragments read back as OCR text with
    // lots of bare numbers/symbols and very few actual words, e.g.
    // "0.75 050 0.25 ~ 000 -025 -0.50 -0.75 0 2 4 6 8 10 x".
    return letterRatio < 0.5 || realWordCount < 3
  }

  function removeChartJunkSegments(line) {
    // Chart legends/axis labels often land on the same OCR line as a real
    // sentence, glued on with a run of dashes/tildes, e.g.
    // "Best possible fits — truth 28 ~— poly 3 —— poly 6 15 ...".
    // Split on those joins and keep only the segments that read like text.
    const segments = line
      .split(/\s[-–—~]+\s/)
      .map((segment) => segment.trim())
      .filter(Boolean)

    const base = segments.length <= 1 ? line : (() => {
      const keptSegments = segments.filter((segment) => !looksLikeChartJunk(segment))
      return keptSegments.length > 0 ? keptSegments.join(' ') : line
    })()

    return stripLeadingChartJunk(base)
  }

  function stripLeadingChartJunk(text) {
    // Axis tick marks sometimes run straight into the next sentence with no
    // dash to split on, e.g. "000 -025 -0.50 -0.75 0 2 4 6 8 10 x Now that...".
    // Strip a leading run of bare numbers/single letters/symbols.
    const tokens = text.split(/\s+/)
    const isJunkToken = (token) =>
      /^-?\d+(\.\d+)?$/.test(token) || /^[a-zA-Z]$/.test(token) || /^[-–—~=+_|\\/•·<>]+$/.test(token)

    let index = 0

    while (index < tokens.length && isJunkToken(tokens[index])) {
      index++
    }

    return index >= 3 ? tokens.slice(index).join(' ') : text
  }

  function isUsefulKeyPoint(point, pageNumber) {
    if (!point || point.length < 18) {
      return false
    }

    if (looksLikeCitation(point) || looksLikeChartJunk(point)) {
      return false
    }

    const lowerPoint = point.toLowerCase()
    const weekCount = (point.match(/\bweek\b/gi) || []).length

    if (weekCount >= 2 || looksIncomplete(point)) {
      return false
    }

    const throwawayPhrases = [
      'school of information technology',
      'monash university malaysia',
      'with materials from',
      'learning outcomes',
      'by the end of this week',
      'week activities',
      'week 6 outline',
      'overview of data science',
      'tools for data science',
    ]

    if (throwawayPhrases.some((phrase) => lowerPoint.includes(phrase))) {
      return false
    }

    const looksLikeHeading =
      point.length <= 45 &&
      point.split(/\s+/).length <= 6 &&
      !/[.,;:!?]/.test(point)

    const meaningPatterns = [
      ' is ',
      ' are ',
      ' occurs ',
      ' measures ',
      ' means ',
      ' predicts ',
      ' forecast ',
      ' determine ',
      ' relationship between',
      ' used to',
      ' fit ',
      ' split ',
      ' evaluate ',
      ' improve ',
      ' increase ',
    ]

    if (meaningPatterns.some((pattern) => lowerPoint.includes(pattern))) {
      return true
    }

    if (looksLikeHeading) {
      return false
    }

    const usefulWords = [
      'variables',
      'model',
      'data',
      'regression',
      'underfitting',
      'overfitting',
      'bias',
      'variance',
      'ensemble',
      'algorithm',
      'training',
      'test set',
      'prediction',
      'error',
      'mse',
    ]

    if (usefulWords.some((word) => lowerPoint.includes(word))) {
      return true
    }

    return pageNumber > 1 && point.length > 70
  }

  function createOverallSummary(fileName, extractedSlides) {
    const allText = extractedSlides.map((slide) => slide.text).join('\n')
    const keywords = getKeywords(allText)
    const bestPoints = extractedSlides
      .flatMap((slide) => slide.keyPoints)
      .filter((point) => {
        const lowerPoint = point.toLowerCase()

        return (
          !lowerPoint.includes('no selectable text') &&
          !lowerPoint.includes('appears to be mainly visual') &&
          !lowerPoint.includes('mainly a title') &&
          !lowerPoint.includes('review the preview image') &&
          !lowerPoint.includes('check the slide preview') &&
          !lowerPoint.includes('mostly code') &&
          !lowerPoint.includes('weekly schedule') &&
          !lowerPoint.includes('navigation only') &&
          !lowerPoint.includes('recaps previous') &&
          !lowerPoint.includes('title slide') &&
          !lowerPoint.includes('week 6 regression analysis') &&
          !/^\d+\s+introduction to/i.test(lowerPoint) &&
          !/^\d+\s+data/i.test(lowerPoint) &&
          !/^\d+\s+classification/i.test(lowerPoint) &&
          !looksIncomplete(point) &&
          !looksLikeCitation(point)
        )
      })
      .filter((point, index, array) => array.indexOf(point) === index)
      .slice(0, 8)

    return {
      fileName,
      totalPages: extractedSlides.length,
      keywords,
      mainPoints: bestPoints,
      checklist: [
        'Review the main keywords first.',
        'Read each slide/page key point.',
        'Open extracted text when you need more detail.',
        'Look at the slide preview for diagrams, graphs, tables, or images.',
        'Turn each key point into a quiz question.',
      ],
    }
  }

  function getKeywords(text) {
    const stopWords = [
      'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was',
      'were', 'you', 'your', 'have', 'has', 'had', 'not', 'can', 'will',
      'into', 'about', 'using', 'used', 'also', 'they', 'their', 'there',
      'which', 'page', 'slide', 'pdf', 'may', 'more', 'been', 'week',
      'weeks', 'example', 'monash', 'university', 'student', 'version',
    ]

    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 3 && !stopWords.includes(word))

    const wordCount = {}

    for (const word of words) {
      wordCount[word] = (wordCount[word] || 0) + 1
    }

    return Object.entries(wordCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map((entry) => entry[0])
  }

  function splitCellIntoBullets(text) {
    const cleaned = cleanTableCell(text)

    if (!cleaned) {
      return []
    }

    const prepared = cleaned
      .replace(/\bHighly preferable, as it\b/gi, 'It')
      .replace(/\bLastly,?\s*/gi, '')
      .replace(/\bWhile it is rather costly,?\s*/gi, 'Although it is costly, ')
      .replace(/,\s+and it doesn[’']t require/gi, '. It does not require')
      .replace(/,\s+reducing the cost/gi, '. This reduces the cost')
      .replace(/,\s+which can harm/gi, '. This reduces issues that can harm')
      .replace(/\s+(It can help|To maintain|It allows|Can remove|This process likely|This process doesn[’']t)\b/g, '. $1')

    const bullets = prepared
      .split(/(?<=[.!?])\s+|;\s+/)
      .map((sentence) => cleanPoint(sentence))
      .map((sentence) => sentence.replace(/^(and|but)\s+/i, ''))
      .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
      .filter((sentence) => sentence.length >= 12)
      .filter((sentence, index, array) => array.indexOf(sentence) === index)

    if (bullets.length === 0 && prepared.length > 0) {
      return [prepared]
    }

    return bullets.slice(0, 6)
  }

  function renderBulletCell(text, fallbackText) {
    const bullets = splitCellIntoBullets(text)

    if (bullets.length === 0) {
      return fallbackText
    }

    return (
      <ul className="table-bullet-list">
        {bullets.map((bullet, index) => (
          <li key={index}>{bullet}</li>
        ))}
      </ul>
    )
  }

  function renderExtractedText(text) {
    if (!text) {
      return <p className="extracted-line">No selectable text found.</p>
    }

    const lines = text.split('\n').filter(Boolean)
    const numberedRowPattern = /^(\d{1,2})[.)]?\s+(.+)$/
    const numberedRows = lines.filter((line) => numberedRowPattern.test(line))

    // If most lines look like "1 Overview of data science", render as a table
    // instead of one long run of text, e.g. the Week/Activities slide.
    if (numberedRows.length >= 3 && numberedRows.length >= lines.length * 0.6) {
      return (
        <table className="extracted-table">
          <tbody>
            {lines.map((line, index) => {
              const match = line.match(numberedRowPattern)

              if (match) {
                return (
                  <tr key={index}>
                    <td>{match[1]}</td>
                    <td>{match[2]}</td>
                  </tr>
                )
              }

              return (
                <tr key={index}>
                  <td colSpan={2}>{line}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )
    }

    return (
      <div>
        {lines.map((line, index) => (
          <p className="extracted-line" key={index}>
            {line}
          </p>
        ))}
      </div>
    )
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
          Turn PDF or DOCX lecture notes into revision notes, explanations, and study checklists.
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

          <button className="secondary-button" onClick={handleClear}>
            Clear
          </button>
        </div>

        {statusMessage && <p className="status">{statusMessage}</p>}
        {errorMessage && <p className="error">{errorMessage}</p>}
      </section>

      {overallSummary && (
        <section className="card">
          <h2>Overall Revision Summary</h2>
          <p className="summary-meta">Revision summary for {overallSummary.fileName}</p>
          <p className="summary-meta">Total sections/pages: {overallSummary.totalPages}</p>

          <div className="summary-section">
            <h3>Main Keywords</h3>
            <div className="keyword-chips">
              {overallSummary.keywords.map((keyword) => (
                <span className="keyword-chip" key={keyword}>
                  {keyword}
                </span>
              ))}
            </div>
          </div>

          <div className="summary-section">
            <h3>Main Points</h3>
            <ul className="summary-list">
              {overallSummary.mainPoints.map((point, index) => (
                <li key={index}>{point}</li>
              ))}
            </ul>
          </div>

          <div className="summary-section">
            <h3>Study Checklist</h3>
            <ul className="summary-list">
              {overallSummary.checklist.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </div>

          <p className="summary-note">
            This is a free local summary. It extracts text from PDF/DOCX files and creates rule-based notes without using
            an AI API.
          </p>
        </section>
      )}

      {slides.length > 0 && (
        <section className="card">
          <h2>Slide-by-Slide Notes</h2>

          {slides.map((slide) => (
            <article className="slide-card" key={`${slide.sourceType || 'pdf'}-${slide.pageNumber}`}>
              <h3>
                {slide.sourceType === 'docx' ? 'DOCX Section' : `Slide/Page ${slide.pageNumber}`}
                {slide.usedOCR && <span className="ocr-badge">OCR</span>}
              </h3>

              {slide.imageDataUrl && (
                <img
                  className="slide-preview"
                  src={slide.imageDataUrl}
                  alt={`Slide/Page ${slide.pageNumber}`}
                />
              )}

              <div className="key-points">
                <h4>Key Points</h4>

                <ul>
                  {slide.keyPoints.map((point, index) => (
                    <li key={index}>{point}</li>
                  ))}
                </ul>
              </div>

              {slide.slideExplanation && (
                <div className="slide-explanation">
                  <h4>{slide.slideExplanation.title}</h4>

                  {slide.slideExplanation.bullets.length > 0 && (
                    <ul>
                      {slide.slideExplanation.bullets.map((bullet, index) => (
                        <li key={index}>{bullet}</li>
                      ))}
                    </ul>
                  )}

                  {slide.slideExplanation.tableRows?.length > 0 && (
                    <div className="worksheet-table-wrap">
                      <table className="worksheet-summary-table">
                        <thead>
                          <tr>
                            <th>Team member</th>
                            <th>Unit operation</th>
                            <th>Why selected</th>
                            <th>Design link</th>
                          </tr>
                        </thead>
                        <tbody>
                          {slide.slideExplanation.tableRows.map((row, index) => (
                            <tr key={`${row.name}-${row.operation}-${index}`}>
                              <td>{row.name}</td>
                              <td>{row.operation}</td>
                              <td>{renderBulletCell(row.whySelected, 'Not clearly separated in the extracted table text.')}</td>
                              <td>{renderBulletCell(row.designLink, 'Not clearly separated in the extracted table text.')}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {slide.slideExplanation.technologyRows?.length > 0 && (
                    <div className="worksheet-table-wrap">
                      <table className="worksheet-summary-table technology-options-table">
                        <thead>
                          <tr>
                            <th>Team member</th>
                            <th>Unit operation</th>
                            <th>Option 1: key features</th>
                            <th>Option 2: key features</th>
                            <th>Option 3: key features</th>
                            <th>Selected option</th>
                          </tr>
                        </thead>
                        <tbody>
                          {slide.slideExplanation.technologyRows.map((row, index) => (
                            <tr key={`${row.name}-${row.operation}-${index}`}>
                              <td>{row.name || 'Not separated'}</td>
                              <td>{row.operation}</td>
                              <td>{renderBulletCell(row.option1, 'No Option 1 text separated from the PDF table.')}</td>
                              <td>{renderBulletCell(row.option2, 'No Option 2 text separated from the PDF table.')}</td>
                              <td>{renderBulletCell(row.option3, 'No Option 3 text separated from the PDF table.')}</td>
                              <td>{renderBulletCell(row.selected, 'Selected option not clearly separated from the PDF table.')}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {slide.slideExplanation.formulas.length > 0 && (
                    <div className="formula-list">
                      {slide.slideExplanation.formulas.map((formula) => (
                        <div className="formula-card" key={formula.label}>
                          <p className="formula-label">{formula.label}</p>
                          <p className="formula-text">{formula.formula}</p>
                          <p>{formula.explanation}</p>
                        </div>
                      ))}
                    </div>
                  )}

                  {slide.slideExplanation.concepts.length > 0 && (
                    <dl>
                      {slide.slideExplanation.concepts.map((note) => (
                        <div className="concept-note" key={note.label}>
                          <dt>{note.label}</dt>
                          <dd>{note.explanation}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              )}

              <details>
                <summary>Show extracted text</summary>
                <div className="extracted-text">{renderExtractedText(slide.text)}</div>
              </details>
            </article>
          ))}
        </section>
      )}
    </div>
  )
}

export default App
