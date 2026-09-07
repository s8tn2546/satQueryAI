import { gsap } from 'gsap';
import { useGSAP } from '@gsap/react';
import * as React from 'react';
import { cn } from '../../lib/utils';

const Input = React.forwardRef(
  ({ className, wrapperClassName, type = 'text', ...props }, ref) => {
    const radius = 100; // change this to increase the radius of the hover effect
    const containerRef = React.useRef(null);
    const gradientRef = React.useRef(null);
    const [mousePosition, setMousePosition] = React.useState({ x: 0, y: 0 });

    useGSAP(
      () => {
        gsap.set(gradientRef.current, {
          background: `radial-gradient(0px circle at ${mousePosition.x}px ${mousePosition.y}px, rgba(var(--accent-rgb), 0.3), transparent 80%)`,
        });
      },
      { scope: containerRef },
    );

    function handleMouseMove(e) {
      if (!containerRef.current) return;

      const { left, top } = containerRef.current.getBoundingClientRect();
      const x = e.clientX - left;
      const y = e.clientY - top;

      setMousePosition({ x, y });

      gsap.to(gradientRef.current, {
        background: `radial-gradient(${radius}px circle at ${x}px ${y}px, rgba(var(--accent-rgb), 0.3), transparent 80%)`,
        duration: 0.1,
      });
    }

    function handleMouseEnter(e) {
      if (!containerRef.current) return;

      const { left, top } = containerRef.current.getBoundingClientRect();
      const x = e.clientX - left;
      const y = e.clientY - top;

      setMousePosition({ x, y });
      gsap.set(gradientRef.current, {
        background: `radial-gradient(0px circle at ${x}px ${y}px, rgba(var(--accent-rgb), 0.3), transparent 80%)`,
      });

      gsap.to(gradientRef.current, {
        background: `radial-gradient(${radius}px circle at ${x}px ${y}px, rgba(var(--accent-rgb), 0.3), transparent 80%)`,
        duration: 0.3,
      });
    }

    function handleMouseLeave() {
      gsap.to(gradientRef.current, {
        background: `radial-gradient(0px circle at ${mousePosition.x}px ${mousePosition.y}px, rgba(var(--accent-rgb), 0.3), transparent 80%)`,
        duration: 0.3,
      });
    }

    return (
      <div
        ref={containerRef}
        className={cn(
          'group/input relative rounded-full p-[2px] transition duration-300',
          wrapperClassName,
        )}
        onMouseMove={handleMouseMove}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div ref={gradientRef} className="absolute inset-0 rounded-full" />
        <input
          type={type}
          className={cn(
            'relative z-10 h-full w-full rounded-full border-none bg-transparent px-3 text-sm outline-none',
            className,
          )}
          ref={ref}
          {...props}
        />
      </div>
    );
  },
);
Input.displayName = 'Input';

export { Input };

export default Input;