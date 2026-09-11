import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AuthForm } from "../components/ui/auth-form";
import LoadingScreen from "../components/ui/loading-screen";
import HalfEarth from "../components/ui/half-earth";
import { cn } from "../lib/utils";

export default function Login() {
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);

  // Open animation: fade + slide the login section in on mount
  useEffect(() => {
    const t = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(t);
  }, []);

  const handleAuthSubmit = () => {
    setIsLoading(true);
  };

  // Close animation: slide the section out, then navigate back to landing
  const handleBackToHome = (e: React.MouseEvent) => {
    e.preventDefault();
    if (leaving) return;
    setLeaving(true);
    setTimeout(() => navigate("/"), 600);
  };

  if (isLoading) {
    return <LoadingScreen onComplete={() => navigate("/app")} duration={5000} />;
  }

  return (
    <div
      className={cn(
        "relative flex min-h-screen w-full items-center justify-center overflow-hidden bg-background text-foreground px-4 py-12 transition-all duration-500 ease-out",
        leaving && "opacity-0"
      )}
    >
      {/* Earth covering the central area */}
      <div
        className={cn(
          "transition-all duration-700 ease-out",
          open ? "opacity-100" : "opacity-0",
          leaving && "opacity-0 scale-105"
        )}
      >
        <HalfEarth />
      </div>

      {/* Ambient blue background blobs */}
      <div className="pointer-events-none absolute -top-32 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-primary/20 blur-3xl" />
      <div className="pointer-events-none absolute bottom-0 right-0 h-72 w-72 rounded-full bg-primary/10 blur-3xl" />
      <div className="pointer-events-none absolute top-1/3 -left-24 h-72 w-72 rounded-full bg-white/5 blur-3xl" />

      {/* Login section */}
      <div
        className={cn(
          "relative z-10 w-full max-w-md transition-all duration-700 ease-out",
          open ? "translate-y-0 opacity-100" : "translate-y-10 opacity-0",
          leaving && "translate-y-12 opacity-0"
        )}
      >
        <div className="rounded-3xl border border-white/15 bg-white/10 p-4 sm:p-5 backdrop-blur-xl shadow-[0_8px_40px_rgba(0,0,0,0.25)]">
          <div className="mb-2 flex flex-col items-center text-center">
            <Link
              to="/"
              onClick={handleBackToHome}
              className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition hover:text-foreground"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m12 19-7-7 7-7" />
                <path d="M19 12H5" />
              </svg>
              Back To Home
            </Link>

            <div className="relative mb-4">
              <img
                src="/image.png"
                alt="SatQuery AI logo background glow"
                aria-hidden="true"
                className="absolute inset-0 h-full w-full object-contain opacity-80 animate-pulse"
                style={{ filter: "blur(6px) drop-shadow(0 0 10px rgba(80,150,255,0.55))" }}
              />
              <img
                src="/image.png"
                alt="SatQuery AI logo"
                className="relative h-auto w-16 sm:w-20 object-contain"
                style={{ filter: "drop-shadow(0 0 4px rgba(80,150,255,0.7)) drop-shadow(0 0 14px rgba(47,125,255,0.4))" }}
              />
            </div>
            <h1 className="text-3xl font-bold tracking-tight">
              SatQuery <span className="text-muted-foreground">AI</span>
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Sign in to start analysing the Earth.
            </p>
          </div>

          <AuthForm onSubmit={handleAuthSubmit} />
        </div>
      </div>
    </div>
  );
}