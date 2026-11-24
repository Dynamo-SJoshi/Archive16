/**
 * canvas-reader.js - High-DPI Responsive HTML5 Canvas Markdown Reader
 * Features:
 * - High-DPI (window.devicePixelRatio) crisp typography.
 * - Basic Markdown parsing: headings (#, ##, ###), paragraphs, blockquotes, bullets, dividers, bold/italic.
 * - Dynamic height computation and responsive resize handling.
 * - Forensic Watermarking: faint repeating diagonal watermark [friend.email] • [YYYY-MM-DD HH:MM] (~0.06 alpha).
 * - Canvas copy/selection protection & context menu suppression.
 */

export class CanvasArticleReader {
  /**
   * @param {HTMLCanvasElement} canvasElement
   * @param {object} [options]
   */
  constructor(canvasElement, options = {}) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext('2d');
    this.options = options;
    this.currentPost = null;
    this.watermarkInfo = null;

    // Attach right-click prevention
    this.canvas.addEventListener('contextmenu', e => e.preventDefault());
    this.canvas.addEventListener('selectstart', e => e.preventDefault());

    // Debounced resize handler
    this._resizeTimeout = null;
    this._onResize = () => {
      clearTimeout(this._resizeTimeout);
      this._resizeTimeout = setTimeout(() => {
        if (this.currentPost) {
          this.renderPost(this.currentPost, this.watermarkInfo);
        }
      }, 150);
    };
    window.addEventListener('resize', this._onResize);
  }

  destroy() {
    window.removeEventListener('resize', this._onResize);
  }

  /**
   * Parse Markdown content into structured layout blocks
   * @param {string} markdown
   * @returns {Array<object>}
   */
  parseMarkdown(markdown) {
    const lines = markdown.split(/\r?\n/);
    const blocks = [];
    let currentParagraph = [];

    const flushParagraph = () => {
      if (currentParagraph.length > 0) {
        blocks.push({
          type: 'paragraph',
          text: currentParagraph.join(' ')
        });
        currentParagraph = [];
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      if (!line) {
        flushParagraph();
        continue;
      }

      // Divider (--- or ***)
      if (/^(\-{3,}|\*{3,})$/.test(line)) {
        flushParagraph();
        blocks.push({ type: 'divider' });
        continue;
      }

      // Headings
      if (line.startsWith('# ')) {
        flushParagraph();
        blocks.push({ type: 'h1', text: line.slice(2).trim() });
        continue;
      }
      if (line.startsWith('## ')) {
        flushParagraph();
        blocks.push({ type: 'h2', text: line.slice(3).trim() });
        continue;
      }
      if (line.startsWith('### ')) {
        flushParagraph();
        blocks.push({ type: 'h3', text: line.slice(4).trim() });
        continue;
      }

      // Blockquote
      if (line.startsWith('>')) {
        flushParagraph();
        blocks.push({
          type: 'blockquote',
          text: line.replace(/^>\s*/, '').trim()
        });
        continue;
      }

      // Bullet lists (- or *)
      if (/^[-*]\s+/.test(line)) {
        flushParagraph();
        blocks.push({
          type: 'bullet',
          text: line.replace(/^[-*]\s+/, '').trim()
        });
        continue;
      }

      // Regular paragraph line
      currentParagraph.push(line);
    }

    flushParagraph();
    return blocks;
  }

  /**
   * Format watermark timestamp: YYYY-MM-DD HH:MM
   */
  getWatermarkTimestamp() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
  }

  /**
   * Calculate word-wrapped lines
   */
  wrapText(ctx, text, maxWidth) {
    const words = text.split(/\s+/);
    const lines = [];
    let currentLine = '';

    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const metrics = ctx.measureText(testLine);
      if (metrics.width > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) {
      lines.push(currentLine);
    }
    return lines;
  }

  /**
   * Render an article to the canvas
   * @param {object} post - { title, date, tier, summary, content }
   * @param {object} [watermarkInfo] - { email, name }
   */
  renderPost(post, watermarkInfo = {}) {
    this.currentPost = post;
    this.watermarkInfo = watermarkInfo;

    const parent = this.canvas.parentElement;
    const parentWidth = parent ? parent.clientWidth : 780;
    const cssWidth = Math.min(parentWidth, 780);
    const paddingX = cssWidth < 480 ? 20 : 36;
    const contentWidth = cssWidth - (paddingX * 2);

    // Read theme colors from CSS computed style or fallbacks
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark' ||
      (!document.documentElement.getAttribute('data-theme') && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);

    const colors = isDark ? {
      bg: '#14171a',
      text: '#e1e8ed',
      title: '#f5f8fa',
      muted: '#8899a6',
      accent: '#64b5f6',
      border: '#2a3138',
      blockquoteBg: '#1c2228',
      watermark: 'rgba(255, 255, 255, 0.055)',
      badgeBg: post.tier === 'inner' ? '#3e2723' : '#1e3040',
      badgeText: post.tier === 'inner' ? '#ffab91' : '#81d4fa'
    } : {
      bg: '#ffffff',
      text: '#2c3e50',
      title: '#1a252f',
      muted: '#7f8c8d',
      accent: '#2980b9',
      border: '#ecf0f1',
      blockquoteBg: '#f8f9fa',
      watermark: 'rgba(0, 0, 0, 0.055)',
      badgeBg: post.tier === 'inner' ? '#fbe9e7' : '#e1f5fe',
      badgeText: post.tier === 'inner' ? '#d84315' : '#0277bd'
    };

    const blocks = this.parseMarkdown(post.content || '');

    // Measure layout pass to compute exact required height
    let totalHeight = 50; // top padding

    // Title measurement
    totalHeight += 44; // Title approx height
    totalHeight += 24; // Meta line (date, tier)
    totalHeight += 30; // Divider

    // Measure blocks
    // Temporary measurement canvas context
    const measureCanvas = document.createElement('canvas');
    const mCtx = measureCanvas.getContext('2d');

    const layoutBlocks = [];

    for (const block of blocks) {
      if (block.type === 'h1') {
        mCtx.font = 'bold 24px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Georgia, sans-serif';
        const lines = this.wrapText(mCtx, block.text, contentWidth);
        layoutBlocks.push({ ...block, lines, lineHeight: 32, font: mCtx.font });
        totalHeight += lines.length * 32 + 20;
      } else if (block.type === 'h2') {
        mCtx.font = 'bold 20px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Georgia, sans-serif';
        const lines = this.wrapText(mCtx, block.text, contentWidth);
        layoutBlocks.push({ ...block, lines, lineHeight: 28, font: mCtx.font });
        totalHeight += lines.length * 28 + 18;
      } else if (block.type === 'h3') {
        mCtx.font = 'bold 17px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Georgia, sans-serif';
        const lines = this.wrapText(mCtx, block.text, contentWidth);
        layoutBlocks.push({ ...block, lines, lineHeight: 24, font: mCtx.font });
        totalHeight += lines.length * 24 + 14;
      } else if (block.type === 'paragraph') {
        mCtx.font = '16px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Georgia, serif';
        const lines = this.wrapText(mCtx, block.text, contentWidth);
        layoutBlocks.push({ ...block, lines, lineHeight: 26, font: mCtx.font });
        totalHeight += lines.length * 26 + 18;
      } else if (block.type === 'blockquote') {
        mCtx.font = 'italic 16px Georgia, serif';
        const lines = this.wrapText(mCtx, block.text, contentWidth - 36);
        layoutBlocks.push({ ...block, lines, lineHeight: 26, font: mCtx.font });
        totalHeight += lines.length * 26 + 28;
      } else if (block.type === 'bullet') {
        mCtx.font = '16px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        const lines = this.wrapText(mCtx, block.text, contentWidth - 28);
        layoutBlocks.push({ ...block, lines, lineHeight: 25, font: mCtx.font });
        totalHeight += lines.length * 25 + 10;
      } else if (block.type === 'divider') {
        layoutBlocks.push({ ...block });
        totalHeight += 36;
      }
    }

    totalHeight += 60; // bottom padding

    // Setup high-DPI canvas
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(cssWidth * dpr);
    this.canvas.height = Math.floor(totalHeight * dpr);
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${totalHeight}px`;

    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0); // Reset transform
    ctx.scale(dpr, dpr);

    // 1. Draw Background
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, cssWidth, totalHeight);

    // 2. Render Article Header
    let currentY = 50;

    // Article Title
    ctx.fillStyle = colors.title;
    ctx.font = 'bold 28px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Georgia, serif';
    const titleLines = this.wrapText(ctx, post.title || 'Untitled', contentWidth);
    for (const line of titleLines) {
      ctx.fillText(line, paddingX, currentY);
      currentY += 36;
    }

    currentY += 4;

    // Meta: Date + Tier Badge
    ctx.font = '14px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = colors.muted;
    const dateStr = post.date || '';
    ctx.fillText(dateStr, paddingX, currentY);

    const dateWidth = ctx.measureText(dateStr).width;
    const badgeX = paddingX + dateWidth + 14;
    const tierText = (post.tier || 'general').toUpperCase();

    // Badge pill
    const badgeTextWidth = ctx.measureText(tierText).width;
    const badgeW = badgeTextWidth + 16;
    const badgeH = 22;
    const badgeY = currentY - 15;

    ctx.fillStyle = colors.badgeBg;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 11) : ctx.rect(badgeX, badgeY, badgeW, badgeH);
    ctx.fill();

    ctx.fillStyle = colors.badgeText;
    ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillText(tierText, badgeX + 8, currentY - 1);

    currentY += 20;

    // Subtle header line divider
    ctx.strokeStyle = colors.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(paddingX, currentY);
    ctx.lineTo(paddingX + contentWidth, currentY);
    ctx.stroke();

    currentY += 32;

    // 3. Render Markdown Blocks
    for (const block of layoutBlocks) {
      if (block.type === 'h1' || block.type === 'h2' || block.type === 'h3') {
        ctx.fillStyle = colors.title;
        ctx.font = block.font;
        for (const line of block.lines) {
          ctx.fillText(line, paddingX, currentY);
          currentY += block.lineHeight;
        }
        currentY += block.type === 'h1' ? 16 : 12;
      } else if (block.type === 'paragraph') {
        ctx.fillStyle = colors.text;
        ctx.font = block.font;
        for (const line of block.lines) {
          // Check for bold emphasis in paragraph line
          this.renderFormattedLine(ctx, line, paddingX, currentY, colors.text, block.font);
          currentY += block.lineHeight;
        }
        currentY += 14;
      } else if (block.type === 'blockquote') {
        const blockStartY = currentY - 14;
        const blockquoteH = block.lines.length * block.lineHeight + 14;

        // Blockquote background
        ctx.fillStyle = colors.blockquoteBg;
        ctx.beginPath();
        if (ctx.roundRect) {
          ctx.roundRect(paddingX, blockStartY, contentWidth, blockquoteH, 6);
        } else {
          ctx.rect(paddingX, blockStartY, contentWidth, blockquoteH);
        }
        ctx.fill();

        // Left accent bar
        ctx.fillStyle = colors.accent;
        ctx.fillRect(paddingX, blockStartY, 4, blockquoteH);

        // Text
        ctx.fillStyle = colors.muted;
        ctx.font = block.font;
        for (const line of block.lines) {
          ctx.fillText(line, paddingX + 20, currentY);
          currentY += block.lineHeight;
        }
        currentY += 20;
      } else if (block.type === 'bullet') {
        ctx.fillStyle = colors.text;
        ctx.font = block.font;
        // Bullet point dot
        ctx.fillStyle = colors.accent;
        ctx.beginPath();
        ctx.arc(paddingX + 8, currentY - 5, 3, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = colors.text;
        for (let idx = 0; idx < block.lines.length; idx++) {
          const line = block.lines[idx];
          ctx.fillText(line, paddingX + 22, currentY);
          currentY += block.lineHeight;
        }
        currentY += 6;
      } else if (block.type === 'divider') {
        currentY += 10;
        ctx.strokeStyle = colors.border;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(paddingX + 40, currentY);
        ctx.lineTo(paddingX + contentWidth - 40, currentY);
        ctx.stroke();
        currentY += 24;
      }
    }

    // 4. Render Forensic Watermark Layer
    // Repeated diagonal watermark across the canvas
    const email = (watermarkInfo && watermarkInfo.email) || 'confidential';
    const watermarkText = `${email} • ${this.getWatermarkTimestamp()}`;

    this.renderForensicWatermark(ctx, cssWidth, totalHeight, watermarkText, colors.watermark);
  }

  /**
   * Helper to render inline formatting (bold / plain)
   */
  renderFormattedLine(ctx, line, startX, y, defaultColor, baseFont) {
    if (!line.includes('**')) {
      ctx.fillText(line, startX, y);
      return;
    }

    const parts = line.split(/(\*\*.*?\*\*)/g);
    let curX = startX;

    for (const part of parts) {
      if (part.startsWith('**') && part.endsWith('**')) {
        const text = part.slice(2, -2);
        ctx.font = 'bold 16px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Georgia, serif';
        ctx.fillText(text, curX, y);
        curX += ctx.measureText(text).width;
        ctx.font = baseFont;
      } else if (part) {
        ctx.fillText(part, curX, y);
        curX += ctx.measureText(part).width;
      }
    }
  }

  /**
   * Render faint diagonal repeating forensic watermark
   */
  renderForensicWatermark(ctx, width, height, text, color) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.font = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';

    const angle = -25 * (Math.PI / 180);
    const stepX = 280;
    const stepY = 160;

    // Expand bounds to cover rotation
    const diag = Math.sqrt(width * width + height * height);

    ctx.translate(width / 2, height / 2);
    ctx.rotate(angle);
    ctx.translate(-diag / 2, -diag / 2);

    for (let y = 0; y < diag; y += stepY) {
      const offsetX = (Math.floor(y / stepY) % 2 === 0) ? 0 : stepX / 2;
      for (let x = -stepX; x < diag + stepX; x += stepX) {
        ctx.fillText(text, x + offsetX, y);
      }
    }

    ctx.restore();
  }
}
