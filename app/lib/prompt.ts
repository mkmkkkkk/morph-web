import { Manifest } from './store';

/**
 * Build the Morph Context that gets prepended to every user message sent to CC.
 * This tells CC about the canvas state and available APIs.
 *
 * Kept compact to minimize token cost per message.
 */
export function buildMorphContext(manifest: Manifest): string {
  const componentList = manifest.components.length > 0
    ? manifest.components
        .map(c => `- ${c.id}${c.description ? ': ' + c.description : ''}`)
        .join('\n')
    : '(empty canvas)';

  return `[Morph Canvas]
You control a mobile canvas app. User is on phone.

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
export function wrapUserMessage(text: string, manifest: Manifest): string {
  return buildMorphContext(manifest) + '\n\n' + text;
}

/**
 * Build the sketch message that wraps a sketch image for CC.
 * Includes instructions for interpreting hand-drawn UI sketches.
 */
export function buildSketchMessage(imageDataUrl: string): string {
  return `[Sketch from canvas — interpret the drawing and generate/modify components accordingly.
Boxes→buttons/cards, lines→layout, text→labels, position→approximate layout on the grid.]
![sketch](${imageDataUrl})`;
}
