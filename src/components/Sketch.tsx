import { useRef, useState, useCallback, useEffect } from 'react';

type Tool = 'pen' | 'rect' | 'arrow';

interface SketchProps {
  onInsert: (dataUrl: string, bounds: { x: number; y: number; w: number; h: number }) => void;
  onClose: () => void;
}

export default function Sketch({ onInsert, onClose }: SketchProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState('#e07070');
  const lineWidth = 3;
  const drawing = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });
  const startPos = useRef({ x: 0, y: 0 });
  const snapshot = useRef<ImageData | null>(null);
  // Track bounding box of all strokes (in percentage of canvas)
  const allPoints = useRef<{ x: number; y: number }[]>([]);
  // Draggable toolbar
  const toolbarRef = useRef<HTMLDivElement>(null);
  const dragState = useRef({ dragging: false, offsetX: 0, offsetY: 0 });
  const [toolbarPos, setToolbarPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 2;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, []);

  const getPos = (e: React.TouchEvent | React.MouseEvent) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const t = 'touches' in e ? e.touches[0] || e.changedTouches[0] : e;
    return { x: (t as any).clientX - rect.left, y: (t as any).clientY - rect.top };
  };

  const startDraw = useCallback((e: React.TouchEvent | React.MouseEvent) => {
    e.preventDefault();
    drawing.current = true;
    const pos = getPos(e);
    lastPos.current = pos;
    startPos.current = pos;
    allPoints.current.push(pos);
    if (tool !== 'pen') {
      const canvas = canvasRef.current!;
      snapshot.current = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
    }
  }, [tool]);

  const moveDraw = useCallback((e: React.TouchEvent | React.MouseEvent) => {
    if (!drawing.current) return;
    e.preventDefault();
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const pos = getPos(e);
    allPoints.current.push(pos);

    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;

    if (tool === 'pen') {
      ctx.beginPath();
      ctx.moveTo(lastPos.current.x, lastPos.current.y);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
      lastPos.current = pos;
    } else if (snapshot.current) {
      ctx.putImageData(snapshot.current, 0, 0);
      const sx = startPos.current.x, sy = startPos.current.y;
      const ex = pos.x, ey = pos.y;

      if (tool === 'rect') {
        ctx.strokeRect(sx, sy, ex - sx, ey - sy);
      } else if (tool === 'arrow') {
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        const angle = Math.atan2(ey - sy, ex - sx);
        const headLen = 14;
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - headLen * Math.cos(angle - 0.5), ey - headLen * Math.sin(angle - 0.5));
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - headLen * Math.cos(angle + 0.5), ey - headLen * Math.sin(angle + 0.5));
        ctx.stroke();
      }
    }
  }, [tool, color]);

  const endDraw = useCallback(() => {
    drawing.current = false;
    snapshot.current = null;
  }, []);

  const handleInsert = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();

    // Calculate bounding box of all drawn points (as % of screen)
    const pts = allPoints.current;
    if (pts.length === 0) { onClose(); return; }
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);

    const bounds = {
      x: (minX / rect.width) * 100,
      y: (minY / rect.height) * 100,
      w: ((maxX - minX) / rect.width) * 100,
      h: ((maxY - minY) / rect.height) * 100,
    };

    onInsert(canvas.toDataURL('image/png'), bounds);
  };

  // Native touch listeners to bypass React event delegation (canvas intercepts React events)
  useEffect(() => {
    const handle = document.getElementById('sketch-drag-handle');
    if (!handle) return;
    const onStart = (e: TouchEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const t = e.touches[0];
      const tb = toolbarRef.current;
      if (!tb) return;
      const rect = tb.getBoundingClientRect();
      dragState.current = { dragging: true, offsetX: t.clientX - rect.left, offsetY: t.clientY - rect.top };
    };
    const onMove = (e: TouchEvent) => {
      if (!dragState.current.dragging) return;
      e.preventDefault();
      e.stopPropagation();
      const t = e.touches[0];
      const x = Math.max(0, Math.min(window.innerWidth - 200, t.clientX - dragState.current.offsetX));
      const y = Math.max(0, Math.min(window.innerHeight - 100, t.clientY - dragState.current.offsetY));
      setToolbarPos({ x, y });
    };
    const onEnd = () => { dragState.current.dragging = false; };
    handle.addEventListener('touchstart', onStart, { passive: false });
    handle.addEventListener('touchmove', onMove, { passive: false });
    handle.addEventListener('touchend', onEnd);
    return () => {
      handle.removeEventListener('touchstart', onStart);
      handle.removeEventListener('touchmove', onMove);
      handle.removeEventListener('touchend', onEnd);
    };
  }, []);

  const handleClear = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    allPoints.current = [];
  };

  const colors = ['#c8c8c8', '#e07070', '#70b880', '#6899cc', '#d4a853'];

  const toolBtn = (id: Tool, label: string) => (
    <button key={id} tabIndex={-1} onClick={() => setTool(id)} style={{
      padding: '6px 10px', borderRadius: 8, border: 'none', cursor: 'pointer',
      backgroundColor: tool === id ? 'rgba(255,255,255,0.2)' : 'transparent',
      color: tool === id ? '#fff' : '#888', fontSize: 14, fontWeight: tool === id ? 600 : 400,
    }}>{label}</button>
  );

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', flexDirection: 'column' }}>
      {/* Transparent canvas overlay */}
      <canvas
        ref={canvasRef}
        style={{ flex: 1, touchAction: 'none', cursor: 'crosshair', backgroundColor: 'rgba(0,0,0,0.15)' }}
        onTouchStart={startDraw}
        onTouchMove={moveDraw}
        onTouchEnd={endDraw}
        onMouseDown={startDraw}
        onMouseMove={moveDraw}
        onMouseUp={endDraw}
        onMouseLeave={endDraw}
      />

      {/* Floating draggable toolbar */}
      <div ref={toolbarRef} style={{
        position: 'fixed',
        ...(toolbarPos ? { left: toolbarPos.x, top: toolbarPos.y } : { top: '75%', left: '50%', transform: 'translate(-50%, -50%)' }),
        display: 'flex', alignItems: 'center', gap: 3, maxWidth: 'calc(100vw - 32px)',
        padding: '6px 8px', borderRadius: 20,
        backgroundColor: 'rgba(17,17,17,0.95)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
        border: '1px solid rgba(255,255,255,0.08)',
        boxShadow: '0 12px 40px rgba(0,0,0,0.7)',
        zIndex: 1001, touchAction: 'none',
      }}>
        {/* Drag handle — visible grip inside toolbar */}
        <div id="sketch-drag-handle" style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 28, height: 28, cursor: 'grab', touchAction: 'none',
          borderRadius: 8, background: 'rgba(255,255,255,0.06)',
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ width: 12, height: 2, borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.3)' }} />
            <div style={{ width: 12, height: 2, borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.3)' }} />
          </div>
        </div>
        <span style={{ width: 1, height: 20, backgroundColor: 'rgba(255,255,255,0.06)' }} />
        <button tabIndex={-1} onClick={onClose} style={{ padding: '5px 6px', border: 'none', borderRadius: 10, background: 'transparent', color: '#555', fontSize: 15, cursor: 'pointer', fontWeight: 600 }}>&times;</button>
        <span style={{ width: 1, height: 20, backgroundColor: 'rgba(255,255,255,0.06)' }} />
        {colors.map(c => (
          <div key={c} onClick={() => setColor(c)} style={{
            width: 16, height: 16, borderRadius: 8, backgroundColor: c, cursor: 'pointer',
            border: color === c ? '2px solid rgba(255,255,255,0.5)' : '2px solid rgba(255,255,255,0.06)',
            boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
          }} />
        ))}
        <span style={{ width: 1, height: 20, backgroundColor: 'rgba(255,255,255,0.06)' }} />
        {toolBtn('pen', '✏')}
        {toolBtn('rect', '▢')}
        {toolBtn('arrow', '→')}
        <span style={{ width: 1, height: 20, backgroundColor: 'rgba(255,255,255,0.06)' }} />
        <button tabIndex={-1} onClick={handleClear} style={{ padding: '5px 8px', border: 'none', borderRadius: 10, background: 'transparent', color: '#b0903a', fontSize: 12, cursor: 'pointer', fontWeight: 600, fontFamily: 'Menlo, SF Mono, monospace' }}>clr</button>
        <button tabIndex={-1} onClick={handleInsert} style={{ padding: '5px 12px', border: 'none', borderRadius: 12, background: '#30d158', color: '#0a0a0a', fontSize: 12, cursor: 'pointer', fontWeight: 700, fontFamily: 'Menlo, SF Mono, monospace' }}>send</button>
      </div>
    </div>
  );
}
