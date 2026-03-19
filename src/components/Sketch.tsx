import { useRef, useState, useCallback, useEffect } from 'react';
import { motion, AnimatePresence, useMotionValue } from 'framer-motion';

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
  // Stroke history for undo — save canvas state before each stroke
  const strokeHistory = useRef<ImageData[]>([]);
  // Toolbar state
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const dragX = useMotionValue(0);
  const dragY = useMotionValue(0);

  const resetToolbarPos = () => { dragX.set(0); dragY.set(0); };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Delay to ensure layout is complete (Framer Motion animation may affect dimensions)
    const setup = () => {
      const dpr = window.devicePixelRatio || 2;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      const ctx = canvas.getContext('2d')!;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, rect.width, rect.height);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
    };
    // Run after Framer Motion entry animation completes (~300ms)
    const t = setTimeout(setup, 350);
    return () => clearTimeout(t);
  }, []);

  const getPos = (e: React.TouchEvent | React.MouseEvent) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const t = 'touches' in e ? e.touches[0] || e.changedTouches[0] : e;
    // Account for any CSS transform scale on the canvas or parent
    const scaleX = canvas.offsetWidth / rect.width;
    const scaleY = canvas.offsetHeight / rect.height;
    return {
      x: ((t as any).clientX - rect.left) * scaleX,
      y: ((t as any).clientY - rect.top) * scaleY,
    };
  };

  const startDraw = useCallback((e: React.TouchEvent | React.MouseEvent) => {
    e.preventDefault();
    drawing.current = true;
    const pos = getPos(e);
    lastPos.current = pos;
    startPos.current = pos;
    allPoints.current.push(pos);
    // Save state for undo before this stroke
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    strokeHistory.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (tool !== 'pen') {
      snapshot.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
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


  const handleUndo = () => {
    const canvas = canvasRef.current;
    if (!canvas || strokeHistory.current.length === 0) return;
    const ctx = canvas.getContext('2d')!;
    const prev = strokeHistory.current.pop()!;
    ctx.putImageData(prev, 0, 0);
  };

  const handleClear = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    const rect = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);
    allPoints.current = [];
    strokeHistory.current = [];
  };

  const colors = ['#c8c8c8', '#e07070', '#6899cc'];


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
      <motion.div ref={toolbarRef}
        drag dragMomentum={false} dragElastic={0.05}
        dragConstraints={{ left: -12, right: window.innerWidth - 232, top: -(window.innerHeight * 0.7), bottom: window.innerHeight * 0.25 }}
        style={{
          x: dragX, y: dragY,
          position: 'fixed', top: '70%', left: 12,
          display: 'flex', flexDirection: 'column', alignItems: collapsed ? 'center' : 'stretch',
          justifyContent: collapsed ? 'center' : 'flex-start',
          width: collapsed ? 48 : 220,
          minHeight: collapsed ? 48 : 'auto',
          borderRadius: collapsed ? 24 : 16,
          backgroundColor: 'rgba(28,28,30,0.92)', backdropFilter: 'blur(40px)', WebkitBackdropFilter: 'blur(40px)',
          border: '1px solid rgba(255,255,255,0.1)',
          boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
          zIndex: 1001, touchAction: 'none', overflow: 'hidden', cursor: 'grab',
        }}
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 400, damping: 28 }}
      >
        {collapsed ? (
          /* Collapsed: small circle with pen SVG */
          <motion.div
            onClick={() => { setCollapsed(false); resetToolbarPos(); }}
            whileTap={{ scale: 0.9 }}
            style={{ width: 48, height: 48, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ccc" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17 3a2.85 2.85 0 114 4L7.5 20.5 2 22l1.5-5.5Z"/>
            </svg>
          </motion.div>
        ) : (<>
          {/* Drag handle + close */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            height: 28, padding: '0 8px',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
          }}>
            <motion.div whileTap={{ scale: 0.85 }} onClick={onClose} style={{ width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#666" strokeWidth="1.5" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </motion.div>
            <div onClick={() => { setCollapsed(true); resetToolbarPos(); }} style={{ flex: 1, display: 'flex', justifyContent: 'center', cursor: 'pointer' }}>
              <div style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.2)' }} />
            </div>
            <div style={{ width: 20 }} />
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
            <motion.button whileTap={{ scale: 0.85 }} tabIndex={-1} onClick={() => setTool('pen')} style={{
              padding: '6px 10px', borderRadius: 8, border: 'none', cursor: 'pointer',
              backgroundColor: tool === 'pen' ? 'rgba(255,255,255,0.2)' : 'transparent',
              color: tool === 'pen' ? '#fff' : '#888', display: 'flex', alignItems: 'center',
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.85 0 114 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
            </motion.button>
            <motion.button whileTap={{ scale: 0.85 }} tabIndex={-1} onClick={() => setTool('rect')} style={{
              padding: '6px 10px', borderRadius: 8, border: 'none', cursor: 'pointer',
              backgroundColor: tool === 'rect' ? 'rgba(255,255,255,0.2)' : 'transparent',
              color: tool === 'rect' ? '#fff' : '#888', display: 'flex', alignItems: 'center',
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
            </motion.button>
            <motion.button whileTap={{ scale: 0.85 }} tabIndex={-1} onClick={() => setTool('arrow')} style={{
              padding: '6px 10px', borderRadius: 8, border: 'none', cursor: 'pointer',
              backgroundColor: tool === 'arrow' ? 'rgba(255,255,255,0.2)' : 'transparent',
              color: tool === 'arrow' ? '#fff' : '#888', display: 'flex', alignItems: 'center',
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </motion.button>
          </div>

          {/* Row 2: Undo / Clear / Insert + close */}
          <div style={{ display: 'flex', gap: 6, padding: '0 10px 10px' }}>
            <motion.button tabIndex={-1} whileTap={{ scale: 0.93 }} onClick={handleUndo} style={{
              flex: 1, padding: '10px 0', borderRadius: 10, border: 'none', cursor: 'pointer',
              backgroundColor: 'rgba(255,255,255,0.06)', color: '#999', fontSize: 14,
              fontFamily: '-apple-system, system-ui, sans-serif',
            }}>Undo</motion.button>
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
