import { Activity, ArrowLeft, Mail, Search, ShieldCheck, Zap } from "lucide-react";
import { Link } from "react-router";

export default function About() {
  return (
    <div className="min-h-screen bg-[#FFFBF0] text-[#1a1a1a]">
      <header className="border-b-2 border-[#1a1a1a] bg-[#FFFBF0]">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5">
            <div className="flex size-10 items-center justify-center border-2 border-[#1a1a1a] bg-[#FDE68A]"><Activity className="size-5" strokeWidth={2.5} /></div>
            <span className="text-xl font-black tracking-tight">SitePulse</span>
          </Link>
          <Link to="/" className="border-2 border-[#1a1a1a] bg-white px-3 py-1.5 text-sm font-bold shadow-[3px_3px_0px_0px_#1a1a1a] transition-transform hover:-translate-y-0.5">
            Back to scanner
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
        <h1 className="border-b-4 border-[#1a1a1a] pb-4 text-3xl font-black tracking-tight sm:text-4xl">About SitePulse</h1>
        <p className="mt-4 text-base font-medium leading-relaxed sm:text-lg">
          Built by a developer passionate about web security and performance, SitePulse is a free
          website health checker that scans publicly accessible websites for security, SEO,
          performance, and accessibility issues — then explains exactly what to fix first.
        </p>

        <div className="mt-10 space-y-6">
          <section className="border-2 border-[#1a1a1a] bg-white p-5 shadow-[4px_4px_0px_0px_#1a1a1a] sm:p-6">
            <h2 className="mb-3 inline-flex items-center gap-2 border-2 border-[#1a1a1a] bg-[#FDE68A] px-2 py-1 text-base font-black">
              <Search className="size-4" aria-hidden="true" />What SitePulse checks
            </h2>
            <p className="text-sm font-medium leading-relaxed text-[#1a1a1a]/80">
              Every scan analyzes the publicly accessible page you enter across five categories:
              <strong> Performance</strong> (response time, page size), <strong>SEO</strong> (titles,
              meta descriptions, headings, canonical tags), <strong>Security</strong> (HTTPS, SSL
              certificates, HTTP security headers), <strong>Accessibility</strong> (alt text, labels,
              language attributes), and <strong>Technical Health</strong> (viewport, charset,
              redirects). Each report ends with a transparent 0–100 health score and prioritized
              recommendations.
            </p>
          </section>

          <section className="border-2 border-[#1a1a1a] bg-white p-5 shadow-[4px_4px_0px_0px_#1a1a1a] sm:p-6">
            <h2 className="mb-3 inline-flex items-center gap-2 border-2 border-[#1a1a1a] bg-[#DBEAFE] px-2 py-1 text-base font-black">
              <Zap className="size-4" aria-hidden="true" />How it works
            </h2>
            <p className="text-sm font-medium leading-relaxed text-[#1a1a1a]/80">
              We fetch your publicly accessible webpage and analyze the HTML and HTTP response.
              No passwords, no API keys, no private data.
            </p>
          </section>

          <section className="border-2 border-[#1a1a1a] bg-white p-5 shadow-[4px_4px_0px_0px_#1a1a1a] sm:p-6">
            <h2 className="mb-3 inline-flex items-center gap-2 border-2 border-[#1a1a1a] bg-[#D1FAE5] px-2 py-1 text-base font-black">
              <ShieldCheck className="size-4" aria-hidden="true" />Safe by design
            </h2>
            <p className="text-sm font-medium leading-relaxed text-[#1a1a1a]/80">
              SitePulse only analyzes publicly accessible pages. It never attempts to log in,
              exploit vulnerabilities, or perform destructive actions against scanned sites — the
              same checks a careful auditor would run from a normal browser.
            </p>
          </section>

          <section className="border-2 border-[#1a1a1a] bg-[#FDE68A] p-5 shadow-[4px_4px_0px_0px_#1a1a1a] sm:p-6">
            <h2 className="mb-3 inline-flex items-center gap-2 border-2 border-[#1a1a1a] bg-white px-2 py-1 text-base font-black">
              <Mail className="size-4" aria-hidden="true" />Contact
            </h2>
            <p className="text-sm font-medium leading-relaxed">
              Questions? Email:{" "}
              <a href="mailto:sitepulse@freebuff.app" className="font-black underline underline-offset-2 hover:no-underline">
                sitepulse@freebuff.app
              </a>
            </p>
          </section>
        </div>

        <Link to="/" className="mt-10 inline-flex items-center gap-2 border-2 border-[#1a1a1a] bg-[#FDE68A] px-6 py-3 text-sm font-black shadow-[3px_3px_0px_0px_#1a1a1a] transition-all hover:bg-[#FCD34D] hover:shadow-[1px_1px_0px_0px_#1a1a1a] hover:translate-x-[2px] hover:translate-y-[2px]">
          <ArrowLeft className="size-4" aria-hidden="true" />Scan a website now
        </Link>
      </main>

      <footer className="border-t-2 border-[#1a1a1a] bg-[#1a1a1a] py-8 text-white">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-center gap-x-6 gap-y-2 px-4 text-sm font-bold sm:justify-between sm:px-6">
          <span className="text-white/50">© {new Date().getFullYear()} SitePulse</span>
          <nav aria-label="Footer" className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
            <Link to="/about" className="text-white/70 underline-offset-2 transition-colors hover:text-white hover:underline">About</Link>
            <Link to="/privacy" className="text-white/70 underline-offset-2 transition-colors hover:text-white hover:underline">Privacy Policy</Link>
            <Link to="/terms" className="text-white/70 underline-offset-2 transition-colors hover:text-white hover:underline">Terms of Service</Link>
            <a href="mailto:sitepulse@freebuff.app" className="text-white/70 underline-offset-2 transition-colors hover:text-white hover:underline">Contact</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
