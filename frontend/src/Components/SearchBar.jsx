import { useState, useRef, useEffect } from 'react';
import { gsap } from 'gsap';
import { Input } from './ui/Input';
import { ShaderSearchIcon } from './ui/ShaderSearchIcon';
import { uploadImages } from '../services/api';

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

const ImageIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <polyline points="21 15 16 10 5 21" />
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

const ACCEPTED_UPLOAD_EXTS = ['.tif', '.tiff', '.gtiff', '.png', '.jpg', '.jpeg'];
const MAX_FILES_BY_MODE = { single: 1, temporal: 2, sar: 2 };

const extOf = (name) => name.slice(name.lastIndexOf('.')).toLowerCase();

export default function SearchBar({ onSubmit, onClear, onModeChange, disabled = false, onTilesChange = () => {} }) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [mode, setMode] = useState('single');
  const [pos, setPos] = useState(0);
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const prevPos = useRef(0);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const submitGlow = useControlGlow();

  const maxFiles = MAX_FILES_BY_MODE[mode] || 1;

  const uploadFiles = async (list) => {
    if (list.length === 0) {
      onTilesChange([]);
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const modality =
        mode === 'single' ? 'optical'
        : mode === 'temporal' ? ['optical', 'optical']
        : ['optical', 'sar'];
      const payload = await uploadImages(list, { modality });
      if (payload && payload.status === 'success') {
        const ids = Array.isArray(payload.tileIds) ? payload.tileIds : [];
        onTilesChange(ids);
      } else {
        setUploadError((payload && payload.error) || 'Image upload failed.');
        onTilesChange([]);
      }
    } catch (err) {
      setUploadError((err && err.message) || 'Image upload failed.');
      onTilesChange([]);
    } finally {
      setUploading(false);
    }
  };

  const handleFilesSelected = (e) => {
    const selected = Array.from(e.target.files || []);
    e.target.value = '';
    if (selected.length === 0) return;

    const invalid = selected.filter(f => !ACCEPTED_UPLOAD_EXTS.includes(extOf(f.name)));
    if (invalid.length > 0) {
      setUploadError(
        `Unsupported file type "${invalid.map(f => extOf(f.name)).join(', ')}". Accepted: .tif, .tiff, .gtiff, .png, .jpg, .jpeg.`
      );
      return;
    }

    const merged = [...files];
    for (const f of selected) {
      if (merged.length >= maxFiles) {
        setUploadError(`This mode supports up to ${maxFiles} image${maxFiles > 1 ? 's' : ''}.`);
        break;
      }
      merged.push(f);
    }
    if (merged.length === 0) return;
    setFiles(merged);
    uploadFiles(merged);
  };

  const handleRemoveFile = (index) => {
    const remaining = files.filter((_, i) => i !== index);
    setFiles(remaining);
    if (remaining.length === 0) {
      onTilesChange([]);
    } else {
      uploadFiles(remaining);
    }
  };

  const handleModeChange = (id) => {
    setMode(id);
    onModeChange && onModeChange(id);
    if (files.length > (MAX_FILES_BY_MODE[id] || 1)) {
      setFiles([]);
      setUploadError(null);
      onTilesChange([]);
    }
  };

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
    if (disabled) return;
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
              onClick={() => handleModeChange(id)}
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
          type="button"
          className="composer-plus composer-attach"
          onClick={() => { if (fileInputRef.current) fileInputRef.current.click(); }}
          disabled={disabled || uploading}
          title={maxFiles > 1 ? `Attach up to ${maxFiles} images` : 'Attach an image'}
          aria-label="Attach images"
        >
          <ImageIcon />
        </button>

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

        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          accept=".tif,.tiff,.gtiff,.png,.jpg,.jpeg"
          onChange={handleFilesSelected}
        />
      </div>

      {(files.length > 0 || uploading || uploadError) && (
        <div className="composer-files-wrap">
          <div className="composer-files">
            {files.map((f, i) => (
              <span key={`${f.name}-${i}`} className="composer-file-chip">
                <span className="composer-file-name">{f.name}</span>
                <button
                  type="button"
                  className="composer-file-remove"
                  onClick={() => handleRemoveFile(i)}
                  disabled={uploading}
                  aria-label={`Remove ${f.name}`}
                >
                  <XIcon />
                </button>
              </span>
            ))}
            {uploading && <span className="composer-file-state">Uploading...</span>}
          </div>
          {uploadError && <div className="composer-files-error">{uploadError}</div>}
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