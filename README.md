# Study Sprint

Study Sprint is a no-API lecture revision tool built with React, Vite, PDF.js, and Tesseract.js OCR. It helps students turn lecture PDFs into quick revision notes without needing paid AI API credits.

## Features

- Upload lecture PDFs
- Extract selectable PDF text with PDF.js
- Use OCR fallback for scanned/image-based PDFs
- Generate slide-by-slide key points
- Show slide preview images
- Create main keywords and study checklist
- Filter common noise such as references, chart axis text, and code fragments
- Keep extracted text available for manual checking

## Why no API?

This version is fully local in the browser. It does not send files to an AI service and does not require an API key. Because it is rule-based, it cannot understand graphs or arbitrary code as well as Claude/ChatGPT, but it is useful for fast lecture revision and portfolio demonstration.

## Tech stack

- React
- Vite
- PDF.js (`pdfjs-dist`)
- Tesseract.js OCR
- CSS

## Run locally

```bash
npm install
npm run dev
```

Open the localhost link shown in the terminal.

## Build

```bash
npm run build
```
