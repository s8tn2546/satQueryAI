import React from 'react';

export default function SearchBar() {
  return (
    <div className="absolute bottom-8 left-1/2 -translate-x-1/2 w-full max-w-2xl px-4 z-10">
      <div className="flex items-center bg-slate-900/90 backdrop-blur-md border border-slate-700/60 rounded-full shadow-2xl px-5 py-3">
        <input 
          type="text" 
          placeholder="Search location, coordinates, or ask AI about land & water..." 
          className="w-full bg-transparent text-white placeholder-slate-400 focus:outline-none text-sm px-2"
        />
        <button className="bg-emerald-500 hover:bg-emerald-600 text-white px-5 py-2 rounded-full text-sm font-medium transition-all shadow-lg shadow-emerald-500/20">
          Query
        </button>
      </div>
    </div>
  );
}