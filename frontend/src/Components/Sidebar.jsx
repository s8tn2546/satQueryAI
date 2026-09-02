import React from 'react';

export default function Sidebar() {
  return (
    <div className="absolute left-4 top-4 bottom-4 w-80 bg-slate-900/80 backdrop-blur-md text-white p-5 rounded-2xl shadow-2xl z-10 flex flex-col justify-between border border-slate-700/50">
      <div>
        <h1 className="text-xl font-bold text-emerald-400 mb-1">SatQuery AI</h1>
        <p className="text-xs text-slate-400 mb-6">Interactive Earth Intelligence</p>
        <div className="space-y-3">
          <div className="p-3 bg-slate-800/60 rounded-xl border border-slate-700/50 text-sm text-slate-300">
            🟢 Workspace Active: Ready for frontend.
          </div>
        </div>
      </div>
      <div className="text-xs text-slate-500 text-center">Frontend UI Prototype</div>
    </div>
  );
}