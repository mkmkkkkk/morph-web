import { Manifest } from './store';

/** Color name lookup for common sketch colors. */
function colorName(hex: string): string {
  const map: Record<string, string> = {
    '#ffffff': 'white', '#ff0000': 'red', '#ff453a': 'red',
    '#00ff00': 'green', '#30d158': 'green', '#0000ff': 'blue',
    '#5e5ce6': 'purple', '#ff9f0a': 'orange', '#ffff00': 'yellow',
    '#ff00ff': 'magenta', '#00ffff': 'cyan', '#ff6b6b': 'red',
    '#4ecdc4': 'teal', '#45b7d1': 'blue', '#96ceb4': 'green',
    '#ffd93d': 'yellow', '#6c5ce7': 'purple', '#a8e6cf': 'green',
    '#ff8a5c': 'orange', '#ea5455': 'red',
  };
  return map[hex.toLowerCase()] || hex;
}

/**
 * Build the Morph Context that gets prepended to every user message sent to CC.
 * This tells CC about the canvas state and available APIs.
 *
 * Kept compact to minimize token cost per message.
 */
export function buildMorphContext(manifest: Manifest, activeTab?: string): string {
  const componentList = manifest.components.length > 0
    ? manifest.components
        .map(c => `- ${c.id}${c.description ? ': ' + c.description : ''}`)
        .join('\n')
    : '(empty canvas)';

  const viewingLine = activeTab ? `\nUser is currently viewing: ${activeTab}` : '';

  return `[Morph Canvas]
You control a mobile canvas app. User is on phone.${viewingLine}

Canvas components:
${componentList}

Generate components as:
\`\`\`morph-component:kebab-id
<!-- description: one line -->
<div class="morph-component" id="kebab-id">
  <style>#kebab-id { /* scoped */ }</style>
  <!-- content -->
  <script>
    // morph.send(msg) — message CC
    // morph.on('message', cb) — listen for CC replies
    // morph.store.get(k) / morph.store.set(k,v) — local storage
  </script>
</div>
\`\`\`

Rules: self-contained HTML, scope CSS with #id, dark theme (#0a0a0a bg, rgba(28,28,30,0.95) cards, #fff text), mobile touch targets ≥44px, 14px border-radius.
Design tokens: green #30d158, blue #5e5ce6, red #ff453a, orange #ff9f0a. Grid: 24px.
Same ID = update existing component. Plain text = message bubble.`;
}

/**
 * Wrap a user message with Morph context for sending to CC.
 */
export function wrapUserMessage(text: string, manifest: Manifest, activeTab?: string): string {
  return buildMorphContext(manifest, activeTab) + '\n\n' + text;
}

/**
 * Build the sketch message that wraps a sketch image for CC.
 * Includes instructions for interpreting hand-drawn UI sketches.
 * Optionally includes dimension info so CC can position components accurately.
 */
export function buildSketchMessage(
  imageDataUrl: string,
  dimensions?: { width: number; height: number; viewportWidth: number; viewportHeight: number },
  strokes?: Array<{ color: string; bbox: { x: number; y: number; w: number; h: number }; points: Array<{ x: number; y: number }> }>,
): string {
  const dimInfo = dimensions
    ? `\nViewport: ${dimensions.viewportWidth}x${dimensions.viewportHeight}px.`
    : '';

  // Build stroke coordinate data — exact positions + color grouping.
  // Shape recognition and spatial intent are left to AI vision on the image.
  let strokeInfo = '';
  if (strokes && strokes.length > 0) {
    const vw = dimensions?.viewportWidth || 0;
    const vh = dimensions?.viewportHeight || 0;

    const fmtPos = (x: number, y: number) => {
      const px = vw ? `${Math.round(x / vw * 100)}%` : `${x}px`;
      const py = vh ? `${Math.round(y / vh * 100)}%` : `${y}px`;
      return `(${px}, ${py})`;
    };
    const fmtSize = (w: number, h: number) => {
      const pw = vw ? `${Math.round(w / vw * 100)}%` : `${w}px`;
      const ph = vh ? `${Math.round(h / vh * 100)}%` : `${h}px`;
      return `${pw}x${ph}`;
    };

    // Group strokes by color
    const colorGroups = new Map<string, Array<{ index: number; bbox: { x: number; y: number; w: number; h: number } }>>();
    strokes.forEach((s, i) => {
      const key = s.color.toLowerCase();
      if (!colorGroups.has(key)) colorGroups.set(key, []);
      colorGroups.get(key)!.push({ index: i, bbox: s.bbox });
    });

    // Overall bounding box
    let allMinX = Infinity, allMinY = Infinity, allMaxX = -Infinity, allMaxY = -Infinity;
    strokes.forEach(s => {
      if (s.bbox.x < allMinX) allMinX = s.bbox.x;
      if (s.bbox.y < allMinY) allMinY = s.bbox.y;
      if (s.bbox.x + s.bbox.w > allMaxX) allMaxX = s.bbox.x + s.bbox.w;
      if (s.bbox.y + s.bbox.h > allMaxY) allMaxY = s.bbox.y + s.bbox.h;
    });

    // Build output grouped by color
    const groupLines: string[] = [];
    colorGroups.forEach((groupStrokes, hex) => {
      const name = colorName(hex);
      const label = name !== hex ? `${name} (${hex})` : hex;
      if (colorGroups.size > 1) {
        groupLines.push(`  [${label}]`);
      }
      groupStrokes.forEach(s => {
        const b = s.bbox;
        const pos = fmtPos(b.x, b.y);
        const size = fmtSize(b.w, b.h);
        groupLines.push(`  ${colorGroups.size > 1 ? '  ' : ''}Stroke ${s.index + 1}: at ${pos}, size ${size}`);
      });
    });

    strokeInfo = `\nDrawing region: ${fmtPos(allMinX, allMinY)}, size ${fmtSize(allMaxX - allMinX, allMaxY - allMinY)}
Annotations (${strokes.length} stroke${strokes.length > 1 ? 's' : ''}, ${colorGroups.size} color${colorGroups.size > 1 ? 's' : ''}):
${groupLines.join('\n')}`;
  }

  return `[Sketch from canvas — interpret the drawing and generate/modify components accordingly.${dimInfo}${strokeInfo}
Look at the image to identify shapes (circles, rectangles, arrows, lines, X marks, etc.) and their intent. Different colors = different annotations the user will reference by color. Use the EXACT coordinates above for positioning.]
![sketch](${imageDataUrl})`;
}

/**
 * Build a message wrapping a photo/image attachment for CC.
 */
export function buildImageMessage(imageDataUrl: string, caption?: string): string {
  const intro = caption
    ? `[Photo attached: ${caption}]`
    : '[Photo attached from device camera/library]';
  return `${intro}\n![photo](${imageDataUrl})`;
}

/**
 * Build a message wrapping a file attachment for CC.
 * Text files are sent inline; binary files as base64.
 */
export function buildFileMessage(file: { name: string; mime: string; base64: string; size: number }): string {
  const sizeStr = file.size > 1024 * 1024
    ? `${(file.size / 1024 / 1024).toFixed(1)}MB`
    : `${(file.size / 1024).toFixed(1)}KB`;

  const isText = file.mime.startsWith('text/') ||
    /\.(json|md|yml|yaml|xml|csv|tsv|log|sh|py|ts|tsx|js|jsx|html|css|sql|toml|ini|cfg|conf|env|txt)$/i.test(file.name);

  if (isText) {
    // Decode base64 → utf-8 text for inline display
    const text = globalThis.atob
      ? globalThis.atob(file.base64)
      : Buffer.from(file.base64, 'base64').toString('utf-8');
    return `[File: ${file.name} (${sizeStr})]\n\`\`\`\n${text}\n\`\`\``;
  }

  return `[File: ${file.name} (${sizeStr}, ${file.mime})]\n[base64 data attached — use this to write the file on the computer]\ndata:${file.mime};base64,${file.base64}`;
}
