import { useState, useRef } from 'react';
import { gsap } from 'gsap';
import { ShaderSearchIcon } from './ui/ShaderSearchIcon';

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

const PlusIcon = ({ size = 17 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const XIcon = ({ size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
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

function getRoiMeta(roi) {
  if (!roi) return null;
  const name = roi.name || 'Globe Region ROI';
  let areaText = '';
  if (roi.bounds && Array.isArray(roi.bounds) && roi.bounds.length === 4) {
    const [w, s, e, n] = roi.bounds;
    const latRad = ((s + n) / 2) * (Math.PI / 180);
    const widthKm = Math.abs(e - w) * 111.32 * Math.cos(latRad);
    const heightKm = Math.abs(n - s) * 111.32;
    const area = (widthKm * heightKm).toFixed(2);
    areaText = `${area} km²`;
  }
  return { name, areaText };
}

export default function SearchBar({ 
  onSubmit, 
  onClear, 
  onModeChange,
  disabled = false,
  onTilesChange = () => {},
  roiAttachment = null,
  onClearRoi = () => {}
}) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [mode, setMode] = useState('single');
  const [images, setImages] = useState([]);
  const [uploadError, setUploadError] = useState(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const {
    controlRef: submitControlRef,
    glowRef: submitGlowRef,
    onGlowMove: onSubmitGlowMove,
    onGlowEnter: onSubmitGlowEnter,
    onGlowLeave: onSubmitGlowLeave,
  } = useControlGlow();

  const {
    controlRef: plusControlRef,
    glowRef: plusGlowRef,
    onGlowMove: onPlusGlowMove,
    onGlowEnter: onPlusGlowEnter,
    onGlowLeave: onPlusGlowLeave,
  } = useControlGlow();

  const handleFileChange = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setUploadError(null);

    const validFiles = [];
    const MAX_SIZE = 50 * 1024 * 1024; // 50MB limit

    for (const file of files) {
      if (file.size > MAX_SIZE) {
        setUploadError(`"${file.name}" exceeds 50MB limit.`);
        continue;
      }
      validFiles.push({
        id: Math.random().toString(36).substring(2, 9),
        file,
        url: URL.createObjectURL(file),
        name: file.name,
      });
    }

    if (validFiles.length > 0) {
      setImages((prev) => {
        const next = [...prev, ...validFiles];
        onTilesChange(next.map(f => f.id));
        return next;
      });
    }
    e.target.value = '';
  };

  const removeImage = (id) => {
    setImages((prev) => {
      const target = prev.find((img) => img.id === id);
      if (target && target.url) URL.revokeObjectURL(target.url);
      const updated = prev.filter((img) => img.id !== id);
      onTilesChange(updated.map(f => f.id));
      return updated;
    });
  };

  const handleSearch = () => {
    const submittedQuery = query.trim();
    if (!submittedQuery && images.length === 0) return;
    onClear && onClear();
    onSubmit && onSubmit(submittedQuery, mode, images);
    setQuery('');
    setImages([]);
    if (inputRef.current) inputRef.current.focus();
  };

  return (
    <div className="composer-wrap w-full">
      <div className="composer-label-row">
        <span className="composer-label">QUERY ACTIVE LOCATION</span>
        {uploadError && <span className="composer-upload-error">{uploadError}</span>}
        <div className="composer-mode-pills">
          {modes.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`composer-mode-pill ${mode === id ? 'active' : ''}`}
              onClick={() => { setMode(id); onModeChange && onModeChange(id); }}
              disabled={disabled}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="composer-row w-full">
        <button
          type="button"
          ref={plusControlRef}
          className="composer-plus"
          onMouseMove={onPlusGlowMove}
          onMouseEnter={onPlusGlowEnter}
          onMouseLeave={onPlusGlowLeave}
          onClick={() => fileInputRef.current && fileInputRef.current.click()}
          title="Upload imagery"
          disabled={disabled}
        >
          <span ref={plusGlowRef} className="composer-btn-glow" />
          <PlusIcon />
        </button>

        <div
          className={`new-composer flex-1 w-full ${focused ? 'focused' : ''}`}
          onClick={() => { if (inputRef.current) inputRef.current.focus(); }}
        >
          <SearchIcon />
          <input
            ref={inputRef}
            type="text"
            className="flex-1 w-full h-full bg-transparent border-0 outline-none text-slate-100 text-sm px-2 min-w-0"
            value={query}
            onChange={e => { setQuery(e.target.value); onClear && onClear(); }}
            onFocus={() => { setFocused(true); onClear && onClear(); }}
            onBlur={() => setFocused(false)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSearch();
              }
            }}
            placeholder="Ask anything about this satellite scene…"
            aria-label="Satellite analysis question"
            disabled={disabled}
          />
          {query && (
            <button
              type="button"
              className="new-composer-clear ml-auto"
              onMouseDown={(e) => { e.preventDefault(); setQuery(''); }}
              title="Clear text"
            >
              <XIcon />
            </button>
          )}
        </div>

        <button
          type="button"
          ref={submitControlRef}
          className="composer-submit"
          onMouseMove={onSubmitGlowMove}
          onMouseEnter={onSubmitGlowEnter}
          onMouseLeave={onSubmitGlowLeave}
          onMouseDown={(e) => { e.preventDefault(); handleSearch(); }}
          disabled={disabled}
          title="Search"
        >
          <span ref={submitGlowRef} className="composer-btn-glow" />
          <ArrowUpIcon />
        </button>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          accept=".tif,.tiff,.gtiff,.png,.jpg,.jpeg,.webp"
          onChange={handleFileChange}
        />
      </div>

      {(images.length > 0 || roiAttachment) && (
        <div className="composer-files-wrap w-full">
          <div className="composer-files">
            {roiAttachment && (() => {
              const meta = getRoiMeta(roiAttachment);
              return (
                <span className="composer-file-chip roi-chip flex items-center gap-1.5 px-2.5 py-1 bg-cyan-950/60 border border-cyan-500/40 rounded-full text-xs text-cyan-200">
                  <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
                  <span className="composer-file-name font-mono">{meta.name}</span>
                  {meta.areaText && <span className="text-[10px] text-cyan-300/80 font-mono">({meta.areaText})</span>}
                  <button
                    type="button"
                    className="composer-file-remove ml-1 hover:text-white"
                    onClick={onClearRoi}
                    aria-label="Remove ROI region"
                  >
                    <XIcon />
                  </button>
                </span>
              );
            })()}
            {images.map((img) => (
              <span key={img.id} className="composer-file-chip">
                <span className="composer-file-name">{img.name}</span>
                <button
                  type="button"
                  className="composer-file-remove"
                  onClick={() => removeImage(img.id)}
                  aria-label={`Remove ${img.name}`}
                >
                  <XIcon />
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
