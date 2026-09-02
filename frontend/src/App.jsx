import React from 'react';
import GlobeView from './Components/GlobeView';
import Sidebar from './Components/Sidebar';
import SearchBar from './Components/SearchBar';

export default function App() {
  return (
    <div className="relative w-screen h-screen overflow-hidden bg-slate-950">
      {/* 1. 3D Globe Background Layer */}
      <GlobeView />

      {/* 2. Left Analysis Workspace Sidebar */}
      <Sidebar />

      {/* 3. Floating AI Search Bar at the Bottom */}
      <SearchBar />
    </div>
  );
}