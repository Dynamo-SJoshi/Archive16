/**
 * canvas-reader.js - Block-Chunked High-DPI Canvas Markdown Article Reader
 *
 * Warm Editorial Minimalism:
 * - Block-Level Chunking: Each Markdown element (header, paragraph, blockquote, list, divider)
 *   is rendered onto its own tightly-sized <canvas> element. Mobile browsers never hit GPU
 *   height limits, and touch scrolling remains native 60fps.
 * - Font Readiness & Retina Crispness: Awaits document.fonts.ready before measuring/drawing.
 * - Scaled by window.devicePixelRatio for crisp native typography.
 * - Continuous Watermark: Aligns tiling grid using each block's accumulated vertical offset
 *   so the diagonal watermark flows seamlessly down the entire article.
 * - Anti-Copy friction: user-select disabled, contextmenu prevented.
 */

export class BlockCanvasReader {
  /**
   * @param {HTMLElement} containerElement - Scrollable DOM container for canvas blocks
   */
  constructor(containerElement) {
    this.container = containerElement;
    this.currentPost = null;
    this.friendInfo = null;

    // Font size steps: 0 = Small, 1 = Normal (default), 2 = Large, 3 = Extra Large
    this.sizeStep = 1;

    // Theme palettes matching CSS custom properties
    this.palettes = {
      paper: {
        bg: '#FAF8F5',
        card: '#F2EEE7',
        ink: '#1F1E1C',
        muted: '#6E6A63',
        border: '#E5DFD5',
        accent: '#5B7065',
        watermark: 'rgba(31, 30, 28, 0.18)'
      },
      sepia: {
        bg: '#F3EBD8',
        card: '#EAE0C9',
        ink: '#2C241B',
        muted: '#706354',
        border: '#DFD3BA',
        accent: '#8C5A3C',
        watermark: 'rgba(44, 36, 27, 0.20)'
      },
      dark: {
        bg: '#161513',
        card: '#1F1D1A',
        ink: '#E8E4DC',
        muted: '#9A9389',
        border: '#2D2A26',
        accent: '#8AA697',
        watermark: 'rgba(232, 228, 220, 0.20)'
      }
    };

    // Debounced resize handler
    this._resizeTimeout = null;
    this._onResize = () => {
      clearTimeout(this._resizeTimeout);
      this._resizeTimeout = setTimeout(() => {
        if (this.currentPost) {
          this.renderArticle(this.currentPost, this.friendInfo);
        }
      }, 150);
    };
    window.addEventListener('resize', this._onResize);
  }

  destroy() {
    window.removeEventListener('resize', this._onResize);
  }

  getCurrentTheme() {
    const theme = document.documentElement.getAttribute('data-theme') || 'paper';
    return this.palettes[theme] || this.palettes.paper;
  }

  setFontSizeStep(step) {
    this.sizeStep = Math.max(0, Math.min(3, step));
    if (this.currentPost) {
      this.renderArticle(this.currentPost, this.friendInfo);
    }
  }

  getSizeScale() {
    switch (this.sizeStep) {
      case 0:
        return { body: 16, title: 30, h1: 26, h2: 22, h3: 18, meta: 13, lhFactor: 1.68 };
      case 2:
        return { body: 20, title: 38, h1: 32, h2: 26, h3: 21, meta: 14, lhFactor: 1.76 };
      case 3:
        return { body: 22, title: 42, h1: 36, h2: 29, h3: 23, meta: 15, lhFactor: 1.82 };
      case 1:
      default:
        return { body: 18, title: 34, h1: 28, h2: 24, h3: 19, meta: 13.5, lhFactor: 1.72 };
    }
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
   * Parse Markdown into structured blocks
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

      // Dividers
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

      // Blockquotes
      if (line.startsWith('>')) {
        flushParagraph();
        blocks.push({
          type: 'blockquote',
          text: line.replace(/^>\s*/, '').trim()
        });
        continue;
      }

      // Bullet items
      if (/^[-*]\s+/.test(line)) {
        flushParagraph();
        blocks.push({
          type: 'bullet',
          text: line.replace(/^[-*]\s+/, '').trim()
        });
        continue;
      }

      currentParagraph.push(line);
    }

    flushParagraph();
    return blocks;
  }

  /**
   * Word wrap helper
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
   * Render continuous repeating diagonal watermark on a block canvas
   * Translates by (0, -offsetY) to maintain global diagonal alignment across chunks
   */
  drawWatermark(ctx, width, height, offsetY, watermarkText, color) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.font = '600 16px "Inter", -apple-system, BlinkMacSystemFont, sans-serif';

    const angle = -25 * (Math.PI / 180);
    const stepX = 320;
    const stepY = 130;

    // Shift context so coordinate (0, 0) is the top of the entire article
    ctx.translate(0, -offsetY);

    // Apply rotation centered on article column width
    ctx.translate(width / 2, 0);
    ctx.rotate(angle);
    ctx.translate(-width / 2, 0);

    // Grid coordinates spanning above and below current block
    const startY = Math.floor((offsetY - 400) / stepY) * stepY;
    const endY = offsetY + height + 400;

    for (let y = startY; y < endY; y += stepY) {
      const rowOffset = (Math.floor(y / stepY) % 2 === 0) ? 0 : stepX / 2;
      for (let x = -width; x < width * 2; x += stepX) {
        ctx.fillText(watermarkText, x + rowOffset, y);
      }
    }

    ctx.restore();
  }

  /**
   * Render inline formatting (bold / italic)
   */
  drawInlineText(ctx, line, startX, y, baseFont, boldFont, italicFont, defaultColor) {
    // Regex for bold **text** or italic *text*
    if (!line.includes('*')) {
      ctx.fillText(line, startX, y);
      return;
    }

    const regex = /(\*\*.*?\*\*|\*.*?\*)/g;
    const tokens = line.split(regex);
    let curX = startX;

    for (const token of tokens) {
      if (!token) continue;

      if (token.startsWith('**') && token.endsWith('**')) {
        const text = token.slice(2, -2);
        ctx.font = boldFont;
        ctx.fillStyle = defaultColor;
        ctx.fillText(text, curX, y);
        curX += ctx.measureText(text).width;
      } else if (token.startsWith('*') && token.endsWith('*')) {
        const text = token.slice(1, -1);
        ctx.font = italicFont;
        ctx.fillStyle = defaultColor;
        ctx.fillText(text, curX, y);
        curX += ctx.measureText(text).width;
      } else {
        ctx.font = baseFont;
        ctx.fillStyle = defaultColor;
        ctx.fillText(token, curX, y);
        curX += ctx.measureText(token).width;
      }
    }
  }

  /**
   * Main render function: parses article, creates tightly sized canvas per block,
   * measures with font readiness, and mounts sequentially into container.
   */
  async renderArticle(post, friendInfo = {}) {
    this.currentPost = post;
    this.friendInfo = friendInfo;

    // Ensure custom fonts are ready before measurement
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready;
    }

    const container = this.container;
    container.innerHTML = '';

    const palette = this.getCurrentTheme();
    const scale = this.getSizeScale();

    // Determine article column width (constrained to max 650px)
    const availWidth = container.clientWidth || 650;
    const cssWidth = Math.min(availWidth, 650);
    const paddingX = cssWidth < 480 ? 18 : 28;
    const contentWidth = cssWidth - (paddingX * 2);

    const dpr = window.devicePixelRatio || 1;
    const email = friendInfo.email || 'private';
    const watermarkText = `${email} • ${this.getWatermarkTimestamp()}`;

    // Measurement canvas
    const measureCanvas = document.createElement('canvas');
    const mCtx = measureCanvas.getContext('2d');

    // Font definitions
    const serifFamily = '"Newsreader", "Source Serif 4", Georgia, serif';
    const sansFamily = '"Inter", -apple-system, BlinkMacSystemFont, sans-serif';

    const fonts = {
      title: `600 ${scale.title}px ${serifFamily}`,
      meta: `500 ${scale.meta}px ${sansFamily}`,
      h1: `600 ${scale.h1}px ${serifFamily}`,
      h2: `600 ${scale.h2}px ${serifFamily}`,
      h3: `600 ${scale.h3}px ${serifFamily}`,
      body: `400 ${scale.body}px ${serifFamily}`,
      bodyBold: `600 ${scale.body}px ${serifFamily}`,
      bodyItalic: `italic 400 ${scale.body}px ${serifFamily}`,
      quote: `italic 400 ${scale.body}px ${serifFamily}`,
      bullet: `400 ${scale.body}px ${serifFamily}`,
      footer: `italic 400 ${scale.meta}px ${serifFamily}`
    };

    let accumulatedOffsetY = 0;

    // Helper: create and configure a canvas chunk
    const createChunkCanvas = (cssHeight, drawFn) => {
      const canvas = document.createElement('canvas');
      canvas.className = 'reader-canvas-block';
      canvas.width = Math.floor(cssWidth * dpr);
      canvas.height = Math.floor(cssHeight * dpr);
      canvas.style.width = `${cssWidth}px`;
      canvas.style.height = `${cssHeight}px`;

      // Copy-protection styling & events
      canvas.style.userSelect = 'none';
      canvas.style.webkitUserSelect = 'none';
      canvas.addEventListener('contextmenu', e => e.preventDefault());
      canvas.addEventListener('selectstart', e => e.preventDefault());

      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);

      // 1. Draw block background
      ctx.fillStyle = palette.bg;
      ctx.fillRect(0, 0, cssWidth, cssHeight);

      // 2. Draw content
      drawFn(ctx);

      // 3. Continuous Watermark aligned with global accumulatedOffsetY (clearly visible overlay)
      this.drawWatermark(ctx, cssWidth, cssHeight, accumulatedOffsetY, watermarkText, palette.watermark);

      container.appendChild(canvas);
      accumulatedOffsetY += cssHeight;
    };

    // ==========================================
    // BLOCK 1: ARTICLE HEADER (Date + Title)
    // ==========================================
    mCtx.font = fonts.title;
    const titleLines = this.wrapText(mCtx, post.title || 'Untitled', contentWidth);
    const titleLineHeight = Math.round(scale.title * 1.25);
    const headerHeight = 36 + 24 + (titleLines.length * titleLineHeight) + 24;

    createChunkCanvas(headerHeight, ctx => {
      let y = 32;

      // Date in understated sans-serif
      ctx.font = fonts.meta;
      ctx.fillStyle = palette.muted;
      ctx.fillText(post.date || '', paddingX, y);
      y += 24;

      // Title in warm serif
      ctx.font = fonts.title;
      ctx.fillStyle = palette.ink;
      for (const line of titleLines) {
        ctx.fillText(line, paddingX, y);
        y += titleLineHeight;
      }
    });

    // ==========================================
    // CONTENT BLOCKS
    // ==========================================
    const rawBlocks = this.parseMarkdown(post.content || '');

    for (const block of rawBlocks) {
      if (block.type === 'h1' || block.type === 'h2' || block.type === 'h3') {
        const font = fonts[block.type];
        const fontSize = scale[block.type];
        const lineHeight = Math.round(fontSize * 1.3);

        mCtx.font = font;
        const lines = this.wrapText(mCtx, block.text, contentWidth);
        const topMargin = block.type === 'h1' ? 32 : (block.type === 'h2' ? 26 : 20);
        const bottomMargin = 12;
        const blockHeight = topMargin + (lines.length * lineHeight) + bottomMargin;

        createChunkCanvas(blockHeight, ctx => {
          ctx.font = font;
          ctx.fillStyle = palette.ink;
          let y = topMargin;
          for (const line of lines) {
            ctx.fillText(line, paddingX, y);
            y += lineHeight;
          }
        });

      } else if (block.type === 'paragraph') {
        const lineHeight = Math.round(scale.body * scale.lhFactor);
        mCtx.font = fonts.body;
        const lines = this.wrapText(mCtx, block.text, contentWidth);
        const blockHeight = (lines.length * lineHeight) + 20;

        createChunkCanvas(blockHeight, ctx => {
          ctx.font = fonts.body;
          ctx.fillStyle = palette.ink;
          let y = scale.body;
          for (const line of lines) {
            this.drawInlineText(
              ctx,
              line,
              paddingX,
              y,
              fonts.body,
              fonts.bodyBold,
              fonts.bodyItalic,
              palette.ink
            );
            y += lineHeight;
          }
        });

      } else if (block.type === 'blockquote') {
        const lineHeight = Math.round(scale.body * scale.lhFactor);
        const quoteInnerWidth = contentWidth - 36;
        mCtx.font = fonts.quote;
        const lines = this.wrapText(mCtx, block.text, quoteInnerWidth);
        const blockHeight = (lines.length * lineHeight) + 32;

        createChunkCanvas(blockHeight, ctx => {
          const bgStartY = 6;
          const bgHeight = blockHeight - 12;

          // Subtle tinted card background
          ctx.fillStyle = palette.card;
          ctx.beginPath();
          if (ctx.roundRect) {
            ctx.roundRect(paddingX, bgStartY, contentWidth, bgHeight, 4);
          } else {
            ctx.rect(paddingX, bgStartY, contentWidth, bgHeight);
          }
          ctx.fill();

          // Left accent border bar
          ctx.fillStyle = palette.accent;
          ctx.fillRect(paddingX, bgStartY, 3, bgHeight);

          // Quote text
          ctx.font = fonts.quote;
          ctx.fillStyle = palette.muted;
          let y = bgStartY + 20;
          for (const line of lines) {
            ctx.fillText(line, paddingX + 22, y);
            y += lineHeight;
          }
        });

      } else if (block.type === 'bullet') {
        const lineHeight = Math.round(scale.body * scale.lhFactor);
        const bulletTextWidth = contentWidth - 26;
        mCtx.font = fonts.bullet;
        const lines = this.wrapText(mCtx, block.text, bulletTextWidth);
        const blockHeight = (lines.length * lineHeight) + 12;

        createChunkCanvas(blockHeight, ctx => {
          // Bullet dot
          ctx.fillStyle = palette.accent;
          ctx.beginPath();
          ctx.arc(paddingX + 6, scale.body - 4, 2.5, 0, Math.PI * 2);
          ctx.fill();

          ctx.font = fonts.bullet;
          ctx.fillStyle = palette.ink;
          let y = scale.body;
          for (const line of lines) {
            this.drawInlineText(
              ctx,
              line,
              paddingX + 22,
              y,
              fonts.bullet,
              fonts.bodyBold,
              fonts.bodyItalic,
              palette.ink
            );
            y += lineHeight;
          }
        });

      } else if (block.type === 'divider') {
        const blockHeight = 44;
        createChunkCanvas(blockHeight, ctx => {
          ctx.strokeStyle = palette.border;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(paddingX + 60, 22);
          ctx.lineTo(paddingX + contentWidth - 60, 22);
          ctx.stroke();
        });
      }
    }

    // ==========================================
    // ARTICLE FOOTER: Warm personal attribution
    // ==========================================
    const footerHeight = 70;
    const friendName = friendInfo.name || 'Friend';
    createChunkCanvas(footerHeight, ctx => {
      ctx.font = fonts.footer;
      ctx.fillStyle = palette.muted;
      ctx.textAlign = 'center';
      ctx.fillText(`Shared privately with ${friendName}.`, cssWidth / 2, 40);
      ctx.textAlign = 'left';
    });
  }
}
