import './globals.css';
import Link from 'next/link';

export const metadata = {
  title: 'Agentic Prompt Validator',
  description: 'AI-powered prompt validation with token, clarity, and safety scoring',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <nav className="nav">
          <Link href="/" className="brand">
            <div className="logo">A</div>
            <div className="name">
              Agentic Prompt Validator
              <small>Token · Clarity · Safety</small>
            </div>
          </Link>
          <div className="nav-links">
            <Link href="/submit">Submit</Link>
            <Link href="/review">Review queue</Link>
            <Link href="/rules">Domain rules</Link>
            <Link href="/cost">Cost</Link>
          </div>
        </nav>
        {children}
      </body>
    </html>
  );
}
