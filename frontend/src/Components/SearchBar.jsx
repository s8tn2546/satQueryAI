import { useState, useRef, useEffect } from 'react';
import { gsap } from 'gsap';
import { Input } from './ui/Input';
import { ShaderSearchIcon } from './ui/ShaderSearchIcon';

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
  <ShaderSearchIcon size={28} />
);

const ArrowUpIcon = ({ size = 17 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="19" x2="12" y2="5" />
    <polyline points="5 12 12 5 19 12" />
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

export default function SearchBar({ onSubmit, onClear, onModeChange }) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [mode, setMode] = useState('single');
  const [pos, setPos] = useState(0);
  const prevPos = useRef(0);
  const inputRef = useRef(null);
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
    prevPos.current = pos;
  }, [pos]);

  const noAnim = prevPos.current > pos;

  const handleSearch = () => {
    const submittedQuery = query.trim();
    if (!submittedQuery) return;
    onClear && onClear();
    onSubmit && onSubmit(submittedQuery, mode);
    setQuery('');
    if (inputRef.current) inputRef.current.focus();
  };

  return (
    <div className="composer-wrap">
      <div className="composer-label-row">
        <span className="composer-label">QUERY ACTIVE LOCATION</span>
        <div className="composer-mode-pills">
          {modes.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`composer-mode-pill ${mode === id ? 'active' : ''}`}
              onClick={() => { setMode(id); onModeChange && onModeChange(id); }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="composer-row">
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
            placeholder="Ask anything about this location…"
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