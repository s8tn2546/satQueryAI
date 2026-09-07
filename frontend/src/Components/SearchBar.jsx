import { useState, useRef } from 'react';
import { gsap } from 'gsap';
import { ShaderSearchIcon } from './ui/ShaderSearchIcon';
import { uploadImages } from '../services/api';

const modes = [
  ['single', 'Single scene'],
  ['temporal', 'T1 + T2'],
  ['sar', 'Optical + SAR'],
];

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
      background: `radial-gradient(${radius}px circle at ${x}px ${y}px, rgba(var(--accent-rgb), 0.3), transparent 80%)`,
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
      background: `radial-gradient(0px circle at ${x}px ${y}px, rgba(var(--accent-rgb), 0.3), transparent 80%)`,
    });
    gsap.to(glowRef.current, {
      background: `radial-gradient(40px circle at ${x}px ${y}px, rgba(var(--accent-rgb), 0.3), transparent 80%)`,
      duration: 0.3,
    });
  };

  const onGlowLeave = () => {
    if (!glowRef.current) return;
    gsap.to(glowRef.current, {
      background: `radial-gradient(0px circle at ${glowPos.x}px ${glowPos.y}px, rgba(var(--accent-rgb), 0.3), transparent 80%)`,
      duration: 0.3,
    });
  };

  return { controlRef, glowRef, onGlowMove, onGlowEnter, onGlowLeave };
};

export default function SearchBar({ 
  onSubmit, 
  onClear, 
  onModeChange, 
  disabled = false, 
  onTilesChange = () => {} 
}) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [mode, setMode] = useState('single');
  const [images, setImages] = useState([]);
  const [uploadError, setUploadError] = useState(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const submitGlow = useControlGlow();
  const plusGlow = useControlGlow();

  const handleFileChange = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setUploadError(null);

    const validFiles = [];
    const MAX_SIZE = 50 * 1024 * 1024; // 50MB

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
      setImages((prev) => [...prev, ...validFiles]);
      onTilesChange(validFiles.map(f => f.id));
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
    <div className="composer-wrap">
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
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="composer-row">
        <button
          type="button"
          ref={plusGlow.controlRef}
          className="composer-plus"
          onMouseMove={plusGlow.onGlowMove}
          onMouseEnter={plusGlow.onGlowEnter}
          onMouseLeave={plusGlow.onGlowLeave}
          onClick={() => fileInputRef.current && fileInputRef.current.click()}
          title="Upload image"
          disabled={disabled}
        >
          <span ref={plusGlow.glowRef} className="composer-btn-glow" />
          <PlusIcon />
        </button>

        <input
          ref={inputRef}
          type="text"
          className="composer-input"
          placeholder="Ask anything about satellite imagery (e.g. detect aircrafts, measure vegetation...)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleSearch();
            }
          }}
          disabled={disabled}
        />

        <button
          type="button"
          ref={submitGlow.controlRef}
          className="composer-submit"
          onMouseMove={submitGlow.onGlowMove}
          onMouseEnter={submitGlow.onGlowEnter}
          onMouseLeave={submitGlow.onGlowLeave}
          onClick={handleSearch}
          disabled={disabled}
          title="Search"
        >
          <span ref={submitGlow.glowRef} className="composer-btn-glow" />
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

      {images.length > 0 && (
        <div className="composer-files-wrap">
          <div className="composer-files">
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
