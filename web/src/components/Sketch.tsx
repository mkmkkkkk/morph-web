import { useRef, useState, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

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
  // Toolbar state
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);

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


  const handleClear = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    allPoints.current = [];
  };

  const colors = ['#c8c8c8', '#e07070', '#6899cc'];

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

      {/* Drag constraint = full screen overlay (the parent div) */}
      {/* Floating draggable toolbar — Framer Motion drag */}
      <motion.div ref={toolbarRef}
        drag dragMomentum={false} dragElastic={0.1}
        dragConstraints={canvasRef}
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{
          scale: 1, opacity: 1,
          width: collapsed ? 48 : 220,
          borderRadius: collapsed ? 24 : 16,
        }}
        transition={{ type: 'spring', stiffness: 400, damping: 28 }}
        style={{
          position: 'fixed', top: '68%', left: collapsed ? 'calc(50% - 24px)' : 'calc(50% - 110px)',
          display: 'flex', flexDirection: 'column', alignItems: collapsed ? 'center' : 'stretch',
          justifyContent: collapsed ? 'center' : 'flex-start',
          minHeight: collapsed ? 48 : 'auto',
          backgroundColor: 'rgba(28,28,30,0.92)', backdropFilter: 'blur(40px)', WebkitBackdropFilter: 'blur(40px)',
          border: '1px solid rgba(255,255,255,0.1)',
          boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
          zIndex: 1001, touchAction: 'none', overflow: 'hidden', cursor: 'grab',
        }}
      >
        {collapsed ? (
          /* Collapsed: small circle with pen icon */
          <motion.div
            onClick={() => setCollapsed(false)}
            whileTap={{ scale: 0.9 }}
            style={{ width: 48, height: 48, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, cursor: 'pointer' }}
          >
            ✏
          </motion.div>
        ) : (<>
          {/* Drag handle — tap to collapse */}
          <div onClick={() => setCollapsed(true)} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            height: 28, cursor: 'pointer',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
          }}>
            <div style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.2)' }} />
          </div>

          {/* Row 1: Colors + Tools */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '8px 12px' }}>
            {colors.map(c => (
              <motion.div key={c} whileTap={{ scale: 0.85 }} onClick={() => setColor(c)} style={{
                width: 22, height: 22, borderRadius: 11, backgroundColor: c, cursor: 'pointer',
                border: color === c ? '2px solid rgba(255,255,255,0.6)' : '2px solid rgba(255,255,255,0.08)',
                boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                transition: 'border-color 0.15s',
              }} />
            ))}
            <span style={{ width: 1, height: 20, backgroundColor: 'rgba(255,255,255,0.08)', margin: '0 2px' }} />
            {toolBtn('pen', '✏')}
            {toolBtn('rect', '▢')}
            {toolBtn('arrow', '→')}
          </div>

          {/* Row 2: Close / Clear / Insert */}
          <div style={{ display: 'flex', gap: 6, padding: '0 10px 10px' }}>
            <motion.button tabIndex={-1} whileTap={{ scale: 0.93 }} onClick={onClose} style={{
              flex: 1, padding: '10px 0', borderRadius: 10, border: 'none', cursor: 'pointer',
              backgroundColor: 'rgba(255,255,255,0.06)', color: '#999', fontSize: 14,
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}>Cancel</motion.button>
            <motion.button tabIndex={-1} whileTap={{ scale: 0.93 }} onClick={handleClear} style={{
              flex: 1, padding: '10px 0', borderRadius: 10, border: 'none', cursor: 'pointer',
              backgroundColor: 'rgba(255,255,255,0.06)', color: '#b0903a', fontSize: 14,
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}>Clear</motion.button>
            <motion.button tabIndex={-1} whileTap={{ scale: 0.93 }} onClick={handleInsert} style={{
              flex: 1, padding: '10px 0', borderRadius: 10, border: 'none', cursor: 'pointer',
              backgroundColor: '#30d158', color: '#0a0a0a', fontSize: 14, fontWeight: 600,
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}>Insert</motion.button>
          </div>
        </>)}
      </motion.div>
    </div>
  );
}
