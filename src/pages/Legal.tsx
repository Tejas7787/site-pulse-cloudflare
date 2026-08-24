import { Activity } from "lucide-react";
import { Link } from "react-router";

type LegalKind = "privacy" | "terms";

const CONTENT: Record<
  LegalKind,
  { title: string; updated: string; sections: { heading: string; body: string[] }[] }
> = {
  privacy: {
    title: "Privacy Policy",
    updated: "Last updated: August 24, 2026",
    sections: [
      {
        heading: "What we collect",
        body: [
          "SitePulse collects only the information needed to run a scan: the public URL you enter and the resulting analysis data for that page. No account or sign-up is required.",
          "We do not request, collect, or store passwords, cookies, API keys, or any private credentials.",
        ],
      },
      {
        heading: "How your scans are used",
        body: [
          "Scan results are stored so you can view and share your report via a unique link. Reports are accessible to anyone with the link, so share them thoughtfully.",
          "We do not sell or share your data with third parties, and we do not use tracking pixels or advertising cookies.",
        ],
      },
      {
        heading: "What SitePulse does not do",
        body: [
          "SitePulse only analyzes publicly accessible pages. It never attempts to log in, exploit vulnerabilities, or perform destructive actions against scanned sites.",
        ],
      },
      {
        heading: "Contact",
        body: [
          "Questions about this policy? Email us at support@sitepulse.app.",
        ],
      },
    ],
  },
  terms: {
    title: "Terms of Service",
    updated: "Last updated: August 24, 2026",
    sections: [
      {
        heading: "Using SitePulse",
        body: [
          "SitePulse is provided free of charge for checking publicly accessible websites. You agree to use it only for sites you own or have permission to analyze.",
        ],
      },
      {
        heading: "Fair use",
        body: [
          "Please don't abuse the service. Automated bulk scanning, attempting to bypass rate limits, or using SitePulse to attack, overload, or probe systems without authorization is strictly prohibited.",
        ],
      },
      {
        heading: "No warranty",
        body: [
          "Scan results are provided \"as is\" for informational purposes only. While we work hard on accuracy, SitePulse makes no guarantees that reports are complete, error-free, or fit for a particular purpose. Security guidance should be verified before acting on it in production environments.",
        ],
      },
      {
        heading: "Limitation of liability",
        body: [
          "To the fullest extent permitted by law, SitePulse is not liable for any damages arising from the use of, or inability to use, the service.",
        ],
      },
      {
        heading: "Changes to these terms",
        body: [
          "We may update these terms from time to time. Continued use of SitePulse after changes are posted constitutes acceptance of the revised terms. Questions? Email support@sitepulse.app.",
        ],
      },
    ],
  },
};

function LegalPage({ kind }: { kind: LegalKind }) {
  const content = CONTENT[kind];
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
        <h1 className="border-b-4 border-[#1a1a1a] pb-4 text-3xl font-black tracking-tight sm:text-4xl">{content.title}</h1>
        <p className="mt-2 text-sm font-medium text-[#1a1a1a]/50">{content.updated}</p>

        <div className="mt-8 space-y-8">
          {content.sections.map((section) => (
            <section key={section.heading} className="border-2 border-[#1a1a1a] bg-white p-5 shadow-[4px_4px_0px_0px_#1a1a1a] sm:p-6">
              <h2 className="mb-3 inline-block border-2 border-[#1a1a1a] bg-[#FDE68A] px-2 py-1 text-base font-black">{section.heading}</h2>
              <div className="space-y-3">
                {section.body.map((paragraph) => (
                  <p key={paragraph.slice(0, 40)} className="text-sm leading-relaxed text-[#1a1a1a]/80">{paragraph}</p>
                ))}
              </div>
            </section>
          ))}
        </div>
      </main>

      <footer className="border-t-2 border-[#1a1a1a] bg-[#1a1a1a] text-white">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-6 sm:flex-row sm:px-6">
          <div className="flex items-center gap-2"><Activity className="size-4" /><span className="text-sm font-bold">SitePulse</span></div>
          <nav className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm font-medium">
            <Link to="/privacy" className="text-white/70 underline-offset-2 transition-colors hover:text-white hover:underline">Privacy Policy</Link>
            <Link to="/terms" className="text-white/70 underline-offset-2 transition-colors hover:text-white hover:underline">Terms of Service</Link>
            <a href="mailto:support@sitepulse.app" className="text-white/70 underline-offset-2 transition-colors hover:text-white hover:underline">Contact</a>
          </nav>
          <p className="text-xs text-white/50">Free website health checker. No tracking. No sign-up required.</p>
        </div>
      </footer>
    </div>
  );
}

export function Privacy() {
  return <LegalPage kind="privacy" />;
}

export function Terms() {
  return <LegalPage kind="terms" />;
}
