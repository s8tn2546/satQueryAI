import { useState, useEffect, useRef, useCallback } from 'react';
import { Sun, Moon } from 'lucide-react';
import { motion } from 'framer-motion';

export default function ThemeToggle() {
  const [particles, setParticles] = useState([]);
  const [isAnimating, setIsAnimating] = useState(false);
  const toggleRef = useRef(null);
  const initRef = useRef(false);

  const [active, setActive] = useState(() => {
    const stored = localStorage.getItem('theme');
    return stored === 'light' ? 'light' : 'dark';
  });

  const isDark = active === 'dark';

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(active);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!initRef.current) return;
    const root = document.documentElement;
    root.classList.remove('light', 'dark');
    root.classList.add(active);
    localStorage.setItem('theme', active);
  }, [active]);

  const generateParticles = useCallback(() => {
    const newParticles = [];
    for (let i = 0; i < 3; i++) {
      newParticles.push({ id: i, delay: i * 0.1, duration: 0.6 + i * 0.1 });
    }
    setParticles(newParticles);
    setIsAnimating(true);
    setTimeout(() => {
      setIsAnimating(false);
      setParticles([]);
    }, 1000);
  }, []);

  const handleToggle = () => {
    generateParticles();
    const root = document.documentElement;
    root.classList.add('theme-transitioning');
    clearTimeout(window.__themeTransitionTimer);
    window.__themeTransitionTimer = setTimeout(() => {
      root.classList.remove('theme-transitioning');
    }, 720);
    setActive(prev => (prev === 'dark' ? 'light' : 'dark'));
  };

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <svg style={{ position: 'absolute', width: 0, height: 0 }}>
        <defs>
          <filter id="grain-light">
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="4" result="noise" />
            <feColorMatrix in="noise" type="saturate" values="0" result="desaturatedNoise" />
            <feComponentTransfer in="desaturatedNoise" result="lightGrain">
              <feFuncA type="linear" slope="0.3" />
            </feComponentTransfer>
            <feBlend in="SourceGraphic" in2="lightGrain" mode="overlay" />
          </filter>
          <filter id="grain-dark">
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="4" result="noise" />
            <feColorMatrix in="noise" type="saturate" values="0" result="desaturatedNoise" />
            <feComponentTransfer in="desaturatedNoise" result="darkGrain">
              <feFuncA type="linear" slope="0.5" />
            </feComponentTransfer>
            <feBlend in="SourceGraphic" in2="darkGrain" mode="overlay" />
          </filter>
        </defs>
      </svg>

      <motion.button
        ref={toggleRef}
        onClick={handleToggle}
        style={{
          position: 'relative',
          display: 'flex',
          height: 44,
          width: 72,
          alignItems: 'center',
          borderRadius: 9999,
          padding: 6,
          transition: 'all 0.3s',
          outline: 'none',
          cursor: 'pointer',
          border: isDark ? '2px solid rgba(51, 65, 85, 0.6)' : '2px solid rgba(203, 213, 225, 0.6)',
          background: isDark
            ? 'radial-gradient(ellipse at top left, #1e293b 0%, #0f172a 40%, #020617 100%)'
            : 'linear-gradient(145deg, #ffffff 0%, #f1f5f9 55%, #e2e8f0 100%)',
          boxShadow: isDark
            ? 'inset 5px 5px 12px rgba(0,0,0,0.9), inset -5px -5px 12px rgba(71,85,105,0.4), inset 8px 8px 16px rgba(0,0,0,0.7), inset -8px -8px 16px rgba(100,116,139,0.2), inset 0 2px 4px rgba(0,0,0,1), inset 0 -2px 4px rgba(71,85,105,0.4), inset 0 0 20px rgba(0,0,0,0.6), 0 1px 1px rgba(255,255,255,0.05), 0 2px 4px rgba(0,0,0,0.4), 0 8px 16px rgba(0,0,0,0.4), 0 16px 32px rgba(0,0,0,0.3), 0 24px 48px rgba(0,0,0,0.2)'
            : 'inset 2px 2px 6px rgba(148,163,184,0.35), inset -2px -2px 6px rgba(255,255,255,0.9), inset 0 0 14px rgba(203,213,225,0.2), 0 1px 2px rgba(255,255,255,0.9), 0 2px 6px rgba(0,0,0,0.08), 0 8px 16px rgba(0,0,0,0.06), 0 16px 32px rgba(0,0,0,0.04)',
        }}
        aria-label={`Switch to ${isDark ? 'light' : 'dark'} mode`}
        role="switch"
        aria-checked={isDark}
        whileTap={{ scale: 0.98 }}
      >
        {/* Inner groove */}
        <div
          style={{
            position: 'absolute', inset: 2, borderRadius: 9999, pointerEvents: 'none',
            boxShadow: isDark
              ? 'inset 0 2px 6px rgba(0,0,0,0.9), inset 0 -1px 3px rgba(71,85,105,0.3)'
              : 'inset 0 2px 6px rgba(100,116,139,0.4), inset 0 -1px 3px rgba(255,255,255,0.8)',
          }}
        />

        {/* Glossy overlay */}
        <div
          style={{
            position: 'absolute', inset: 0, borderRadius: 9999, pointerEvents: 'none', mixBlendMode: 'overlay',
            background: isDark
              ? 'radial-gradient(ellipse at top, rgba(71,85,105,0.15) 0%, transparent 50%), linear-gradient(to bottom, rgba(71,85,105,0.2) 0%, transparent 30%, transparent 70%, rgba(0,0,0,0.3) 100%)'
              : 'radial-gradient(ellipse at top, rgba(255,255,255,0.8) 0%, transparent 50%), linear-gradient(to bottom, rgba(255,255,255,0.7) 0%, transparent 30%, transparent 70%, rgba(148,163,184,0.15) 100%)',
          }}
        />

        {/* Ambient occlusion */}
        <div
          style={{
            position: 'absolute', inset: 0, borderRadius: 9999, pointerEvents: 'none',
            boxShadow: isDark ? 'inset 0 0 15px rgba(0,0,0,0.5)' : 'inset 0 0 15px rgba(148,163,184,0.2)',
          }}
        />

        {/* Background Icons */}
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 11px' }}>
          <Sun size={14} color={isDark ? '#fef3c7' : '#d97706'} />
          <Moon size={14} color={isDark ? '#fef3c7' : '#334155'} />
        </div>

        {/* Thumb */}
        <motion.div
          style={{
            position: 'relative', zIndex: 10, display: 'flex', height: 30, width: 30,
            alignItems: 'center', justifyContent: 'center', borderRadius: 9999, overflow: 'hidden',
            border: isDark ? '1.5px solid rgba(148,163,139,0.3)' : '1.5px solid rgba(255,255,255,0.9)',
            background: isDark
              ? 'linear-gradient(145deg, #64748b 0%, #475569 50%, #334155 100%)'
              : 'linear-gradient(145deg, #ffffff 0%, #fefefe 50%, #f8fafc 100%)',
            boxShadow: isDark
              ? 'inset 2px 2px 4px rgba(100,116,139,0.4), inset -2px -2px 4px rgba(0,0,0,0.8), inset 0 1px 1px rgba(255,255,255,0.15), 0 1px 2px rgba(255,255,255,0.1), 0 8px 32px rgba(0,0,0,0.6), 0 4px 12px rgba(0,0,0,0.5), 0 2px 4px rgba(0,0,0,0.4)'
              : 'inset 2px 2px 4px rgba(203,213,225,0.3), inset -2px -2px 4px rgba(255,255,255,1), inset 0 1px 2px rgba(255,255,255,1), 0 1px 2px rgba(255,255,255,1), 0 8px 32px rgba(0,0,0,0.18), 0 4px 12px rgba(0,0,0,0.12), 0 2px 4px rgba(0,0,0,0.08)',
          }}
          animate={{ x: isDark ? 32 : 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 20 }}
        >
          {/* Thumb glossy */}
          <div
            style={{
              position: 'absolute', inset: 0, borderRadius: 9999, pointerEvents: 'none', mixBlendMode: 'overlay',
              background: 'linear-gradient(to bottom, rgba(255,255,255,0.4) 0%, transparent 40%, rgba(0,0,0,0.1) 100%)',
            }}
          />

          {/* Particles */}
          {isAnimating && particles.map((p) => (
            <motion.div
              key={p.id}
              style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}
            >
              <motion.div
                style={{
                  position: 'absolute', borderRadius: 9999, width: 10, height: 10,
                  background: isDark
                    ? 'radial-gradient(circle, rgba(147,197,253,0.5) 0%, rgba(147,197,253,0) 70%)'
                    : 'radial-gradient(circle, rgba(251,191,36,0.7) 0%, rgba(251,191,36,0) 70%)',
                }}
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: isDark ? 6 : 8, opacity: [0, 1, 0] }}
                transition={{ duration: isDark ? 0.5 : p.duration, delay: p.delay, ease: 'easeOut' }}
              />
            </motion.div>
          ))}

          {/* Icon */}
          <div style={{ position: 'relative', zIndex: 10 }}>
            {isDark ? <Moon size={14} color="#fef3c7" /> : <Sun size={14} color="#f59e0b" />}
          </div>
        </motion.div>
      </motion.button>
    </div>
  );
}
