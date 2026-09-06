import ThemeToggle from './ThemeToggle';

const historyItems = [];

export default function Sidebar({ open, onClose }) {
  return (
    <aside className={`sidebar ${open ? 'open' : ''}`}>
      <div className="sidebar-head">
        <button className="new-chat">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15.5 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2V8.5L15.5 3Z" />
            <path d="M15 3v6h6" />
          </svg>
          New analysis
        </button>
        <button className="sidebar-close" onClick={onClose} title="Close sidebar">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="sidebar-scroll">
        <nav className="sidebar-nav">
          <p className="nav-label nav-label-top">History</p>
          {historyItems.length === 0 ? (
            <p className="nav-empty">Your recent analyses will show up here.</p>
          ) : (
            <ul className="history-list">
              {historyItems.map(item => (
                <li key={item.id}>
                  <button className="history-row">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                    <span>
                      <b>{item.title}</b>
                      <small>{item.task} · {item.time}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>
      </div>

      <div className="sidebar-footer">
        <div className="sidebar-user">
          <div className="sidebar-user-avatar">AK</div>
          <div className="sidebar-user-info">
            <span className="sidebar-user-name">Aryan Kumar</span>
            <span className="sidebar-user-email">aryan@satquery.ai</span>
          </div>
        </div>
        <ThemeToggle />
      </div>
    </aside>
  );
}
