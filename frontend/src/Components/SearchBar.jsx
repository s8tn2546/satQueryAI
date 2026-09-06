import { useState, useRef, useEffect } from 'react';
import { gsap } from 'gsap';
import { Input } from './ui/Input';

const suggestions = [
  'Describe this satellite image',
  'Is there a water body?',
  'What changed between these dates?',
  'Where did the change occur?',
  'Has vegetation decreased?',
  'Compare optical and SAR imagery',
  'Show the vegetation trend',
  'Any cloud cover in this scene?',
  'How much urban expansion has occurred?',
  'Estimate the average elevation here',
  'Classify the land use in this area',
  'Detect possible flood inundation',
  'Measure the surface temperature trend',
  'Has agricultural land been lost?',
];

const modes = [
  ['single', 'Single scene'],
  ['temporal', 'T1 + T2'],
  ['sar', 'Optical + SAR'],
];

const SearchIcon = () => (
  <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--glass-muted-text)', flexShrink: 0 }}>
    <circle cx="11" cy="11" r="8" />
    <line x1="21" y1="21" x2="16.65" y2="16.65" />
  </svg>
);

const ArrowUpIcon = ({ size = 17 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="19" x2="12" y2="5" />
    <polyline points="5 12 12 5 19 12" />
  </svg>
);

const PlusIcon = ({ size = 17 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const XIcon = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const ChevronRightIcon = ({ size = 13 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 18 15 12 9 6" />
  </svg>
);

const LayersIcon = ({ size = 15 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="12 2 2 7 12 12 22 7 12 2" />
    <polyline points="2 17 12 22 22 17" />
    <polyline points="2 12 12 17 22 12" />
  </svg>
);

const CheckIcon = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const useControlGlow = () => {
  const controlRef = useRef(null);
  const glowRef = useRef(null);
  const [glowPos, setGlowPos] = useState({ x: 20, y: 20 });

  const setGlow = (x, y, radius) => {
    if (!glowRef.current) return;
    gsap.to(glowRef.current, {
      background: `radial-gradient(${radius}px circle at ${x}px ${y}px, rgba(var(--accent-rgb), 0.5), transparent 80%)`,
      duration: 0.1,
    });
  };

  const onGlowMove = (e) => {
    if (!controlRef.current) return;
    const { left, top } = controlRef.current.getBoundingClientRect();
    const x = e.clientX - left;
    const y = e.clientY - top;
    setGlowPos({ x, y });
    setGlow(x, y, 40);
  };

  const onGlowEnter = (e) => {
    if (!controlRef.current) return;
    const { left, top } = controlRef.current.getBoundingClientRect();
    const x = e.clientX - left;
    const y = e.clientY - top;
    setGlowPos({ x, y });
    if (!glowRef.current) return;
    gsap.set(glowRef.current, {
      background: `radial-gradient(0px circle at ${x}px ${y}px, rgba(var(--accent-rgb), 0.5), transparent 80%)`,
    });
    gsap.to(glowRef.current, {
      background: `radial-gradient(40px circle at ${x}px ${y}px, rgba(var(--accent-rgb), 0.5), transparent 80%)`,
      duration: 0.3,
    });
  };

  const onGlowLeave = () => {
    if (!glowRef.current) return;
    gsap.to(glowRef.current, {
      background: `radial-gradient(0px circle at ${glowPos.x}px ${glowPos.y}px, rgba(var(--accent-rgb), 0.5), transparent 80%)`,
      duration: 0.3,
    });
  };

  return { controlRef, glowRef, onGlowMove, onGlowEnter, onGlowLeave };
};

export default function SearchBar({ onSubmit, onClear }) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [mode, setMode] = useState('single');
  const [showModes, setShowModes] = useState(false);
  const [pos, setPos] = useState(0);
  const prevPos = useRef(0);
  const inputRef = useRef(null);
  const popoverRef = useRef(null);
  const plusHandled = useRef(false);
  const plusGlow = useControlGlow();
  const submitGlow = useControlGlow();

  const tickerRows = suggestions.concat(suggestions);
  const ROW_STEP = 48;

  useEffect(() => {
    const id = setInterval(() => {
      setPos(p => (p === suggestions.length ? 0 : p + 1));
    }, 3500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!showModes) return;
    const onDocMouseDown = (e) => {
      const onPlus = e.target.closest && e.target.closest('.composer-plus');
      if (onPlus) return;
      if (popoverRef.current && !popoverRef.current.contains(e.target)) {
        setShowModes(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [showModes]);

  useEffect(() => {
    if (!showModes) return;
    const first = popoverRef.current && popoverRef.current.querySelector('.analysis-mode');
    if (first && document.activeElement && document.activeElement.classList.contains('composer-plus')) {
      first.focus();
    }
  }, [showModes]);

  useEffect(() => {
    prevPos.current = pos;
  }, [pos]);

  const noAnim = prevPos.current > pos;

  const handleSearch = () => {
    const submittedQuery = query.trim();
    if (!submittedQuery) return;
    onClear && onClear();
    onSubmit && onSubmit(submittedQuery);
    setQuery('');
    setShowModes(false);
    if (inputRef.current) inputRef.current.focus();
  };

  return (
    <div className="composer-wrap">
      <div className="composer-row">
        <button
          type="button"
          ref={plusGlow.controlRef}
          className="composer-plus"
          onMouseMove={plusGlow.onGlowMove}
          onMouseEnter={plusGlow.onGlowEnter}
          onMouseLeave={plusGlow.onGlowLeave}
          onMouseDown={(e) => { e.preventDefault(); plusHandled.current = true; setShowModes(v => !v); }}
          onClick={() => {
            if (plusHandled.current) { plusHandled.current = false; return; }
            setShowModes(v => !v);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              plusHandled.current = true;
              setShowModes(v => !v);
            }
          }}
          title="Analysis type"
          aria-expanded={showModes}
        >
          <span ref={plusGlow.glowRef} className="composer-btn-glow" />
          <PlusIcon />
        </button>

        <div
          className={`new-composer ${focused ? 'focused' : ''}`}
          onClick={() => { if (inputRef.current) inputRef.current.focus(); }}
        >
          <SearchIcon />
          {query && (
            <button
              className="new-composer-clear"
              onMouseDown={(e) => { e.preventDefault(); setQuery(''); }}
              title="Clear"
            >
              <XIcon />
            </button>
          )}
          <Input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => { setQuery(e.target.value); onClear && onClear(); }}
            onFocus={() => { setFocused(true); onClear && onClear(); }}
            onBlur={() => setFocused(false)}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            placeholder="Search..."
            aria-label="Satellite analysis question"
            wrapperClassName="h-full min-w-0 flex-1"
          />
        </div>

        <button
          ref={submitGlow.controlRef}
          className="composer-submit"
          onMouseMove={submitGlow.onGlowMove}
          onMouseEnter={submitGlow.onGlowEnter}
          onMouseLeave={submitGlow.onGlowLeave}
          onMouseDown={(e) => { e.preventDefault(); handleSearch(); }}
          title="Search"
        >
          <span ref={submitGlow.glowRef} className="composer-btn-glow" />
          <ArrowUpIcon />
        </button>
      </div>

      {showModes && (
        <div ref={popoverRef} className="analysis-popover">
          <p className="analysis-popover-label">Analysis type</p>
          {modes.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`analysis-mode ${mode === id ? 'active' : ''}`}
              onClick={() => { setMode(id); setShowModes(false); }}
            >
              <LayersIcon />
              <span>{label}</span>
              {mode === id && (
                <span className="analysis-mode-check">
                  <CheckIcon />
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {focused && (
        <div className="prediction-stack suggestion-carousel">
          <div
            className={`suggestion-track${noAnim ? ' no-anim' : ''}`}
            style={{ transform: `translateY(${-pos * ROW_STEP}px)` }}
          >
            {tickerRows.map((item, i) => (
              <button
                key={i}
                className="prediction-row suggestion-row"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setQuery(item);
                  if (inputRef.current) inputRef.current.focus();
                }}
              >
                <ChevronRightIcon />
                <span>{item}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}