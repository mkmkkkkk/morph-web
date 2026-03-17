import { Manifest } from './store';

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

  // Build precise stroke coordinate data
  let strokeInfo = '';
  if (strokes && strokes.length > 0) {
    const vw = dimensions?.viewportWidth || 0;
    const vh = dimensions?.viewportHeight || 0;
    const strokeLines = strokes.map((s, i) => {
      const b = s.bbox;
      const pctX = vw ? `${Math.round(b.x / vw * 100)}%` : `${b.x}px`;
      const pctY = vh ? `${Math.round(b.y / vh * 100)}%` : `${b.y}px`;
      const pctW = vw ? `${Math.round(b.w / vw * 100)}%` : `${b.w}px`;
      const pctH = vh ? `${Math.round(b.h / vh * 100)}%` : `${b.h}px`;
      return `  Stroke ${i + 1} (${s.color}): bbox(${pctX}, ${pctY}, ${pctW}x${pctH}) from (${s.points[0].x},${s.points[0].y}) to (${s.points[s.points.length - 1].x},${s.points[s.points.length - 1].y})`;
    });

    // Overall bounding box of all strokes
    let allMinX = Infinity, allMinY = Infinity, allMaxX = -Infinity, allMaxY = -Infinity;
    strokes.forEach(s => {
      if (s.bbox.x < allMinX) allMinX = s.bbox.x;
      if (s.bbox.y < allMinY) allMinY = s.bbox.y;
      if (s.bbox.x + s.bbox.w > allMaxX) allMaxX = s.bbox.x + s.bbox.w;
      if (s.bbox.y + s.bbox.h > allMaxY) allMaxY = s.bbox.y + s.bbox.h;
    });
    const regionX = vw ? `${Math.round(allMinX / vw * 100)}%` : `${allMinX}px`;
    const regionY = vh ? `${Math.round(allMinY / vh * 100)}%` : `${allMinY}px`;
    const regionW = vw ? `${Math.round((allMaxX - allMinX) / vw * 100)}%` : `${allMaxX - allMinX}px`;
    const regionH = vh ? `${Math.round((allMaxY - allMinY) / vh * 100)}%` : `${allMaxY - allMinY}px`;

    strokeInfo = `\nDrawing region: top-left(${regionX}, ${regionY}), size(${regionW}x${regionH})
Strokes (${strokes.length} total, coordinates in CSS px relative to viewport):
${strokeLines.join('\n')}`;
  }

  return `[Sketch from canvas — interpret the drawing and generate/modify components accordingly.${dimInfo}${strokeInfo}
Boxes→buttons/cards, lines→layout, text→labels. Use the EXACT coordinates above for positioning.]
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
