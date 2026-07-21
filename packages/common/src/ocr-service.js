class OcrService {
  constructor({ extractEmbeddedText, extractOcrContent, extractMarkdownContent }) {
    this.extractEmbeddedText = extractEmbeddedText;
    this.extractOcrContent = extractOcrContent;
    this.extractMarkdownContent = extractMarkdownContent;
  }

  normalize(content, limit) {
    return {
      ...content,
      text: String(content.text || '').replace(/\s+\n/g, '\n').trim().slice(0, limit),
      spatialItems: Array.isArray(content.spatialItems) ? content.spatialItems : [],
    };
  }

  async extract(filePath, limit = Number(process.env.DOCUMENT_TEXT_LIMIT || 60000), options = {}) {
    if (options.mode === 'markdown') {
      if (!this.extractMarkdownContent) throw new Error('Markdown extraction is not configured.');
      return this.normalize(await this.extractMarkdownContent(filePath, options), limit);
    }

    const embeddedText = await this.extractEmbeddedText(filePath);
    const minTextLength = Number(process.env.OCR_MIN_TEXT_LENGTH || 80);
    if (embeddedText.trim().length >= minTextLength) {
      return this.normalize({ text: embeddedText, spatialItems: [] }, limit);
    }
    return this.normalize(await this.extractOcrContent(filePath, options), limit);
  }

  async extractText(filePath, limit, options) {
    return (await this.extract(filePath, limit, options)).text;
  }
}

module.exports = { OcrService };
