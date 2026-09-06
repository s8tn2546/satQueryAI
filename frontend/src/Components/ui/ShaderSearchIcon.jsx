"use client"

import { MeshGradient } from "@paper-design/shaders-react"
import { motion } from "framer-motion"
import { useState, useEffect, useRef } from "react"

const colors = [
  "#FFB3D9",
  "#87CEEB",
  "#4A90E2",
  "#2C3E50",
  "#1A1A2E",
]

export function ShaderSearchIcon({ size = 28 }) {
  const [eyeOffset, setEyeOffset] = useState({ x: 0, y: 0 })
  const svgRef = useRef(null)

  useEffect(() => {
    const handleMouseMove = (e) => {
      const svg = svgRef.current
      if (!svg) return
      const rect = svg.getBoundingClientRect()
      const centerX = rect.left + rect.width / 2
      const centerY = rect.top + rect.height / 2
      const deltaX = (e.clientX - centerX) * 0.06
      const deltaY = (e.clientY - centerY) * 0.06
      const max = 5
      setEyeOffset({
        x: Math.max(-max, Math.min(max, deltaX)),
        y: Math.max(-max, Math.min(max, deltaY)),
      })
    }
    window.addEventListener("mousemove", handleMouseMove)
    return () => window.removeEventListener("mousemove", handleMouseMove)
  }, [])

  return (
    <motion.div
      style={{ width: size, height: size, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
      animate={{ y: [0, -2, 0], scaleY: [1, 1.05, 1] }}
      transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
    >
      <svg
        ref={svgRef}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 231 289"
        style={{ overflow: "visible" }}
      >
        <defs>
          <clipPath id="shapeClip-search">
            <path d="M230.809 115.385V249.411C230.809 269.923 214.985 287.282 194.495 288.411C184.544 288.949 175.364 285.718 168.26 280C159.746 273.154 147.769 273.461 139.178 280.23C132.638 285.384 124.381 288.462 115.379 288.462C106.377 288.462 98.1451 285.384 91.6055 280.23C82.912 273.385 70.9353 273.385 62.2415 280.23C55.7532 285.334 47.598 288.411 38.7246 288.462C17.4132 288.615 0 270.667 0 249.359V115.385C0 51.6667 51.6756 0 115.404 0C179.134 0 230.809 51.6667 230.809 115.385Z" />
          </clipPath>
        </defs>

        <foreignObject width="231" height="289" clipPath="url(#shapeClip-search)" style={{ borderRadius: 0 }}>
          <div xmlns="http://www.w3.org/1999/xhtml" style={{ width: "100%", height: "100%" }}>
            <MeshGradient colors={colors} style={{ width: "100%", height: "100%" }} speed={0.8} />
          </div>
        </foreignObject>

        <motion.ellipse
          rx="18"
          ry="26"
          fill="currentColor"
          style={{ color: "#fff" }}
          animate={{ cx: 80 + eyeOffset.x, cy: 118 + eyeOffset.y }}
          transition={{ type: "spring", stiffness: 150, damping: 15 }}
        >
          <animate attributeName="ry" values="26;26;26;3;26" keyTimes="0;0.88;0.92;0.95;1" dur="3.5s" repeatCount="indefinite" />
        </motion.ellipse>

        <motion.ellipse
          rx="18"
          ry="26"
          fill="currentColor"
          style={{ color: "#fff" }}
          animate={{ cx: 152 + eyeOffset.x, cy: 118 + eyeOffset.y }}
          transition={{ type: "spring", stiffness: 150, damping: 15 }}
        >
          <animate attributeName="ry" values="26;26;26;3;26" keyTimes="0;0.88;0.92;0.95;1" dur="3.5s" repeatCount="indefinite" />
        </motion.ellipse>
      </svg>
    </motion.div>
  )
}
