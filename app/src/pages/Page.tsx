import type { ReactNode } from 'react';

/** The frame every page but the game, the studio and the landing page sits in. */
export function Page(props: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar-row">
          <a className="buttonlink" href="#/">← Home</a>
          <strong className="grow studiotitle">{props.title}</strong>
          {props.aside}
        </div>
      </header>
      <main className="page-body">{props.children}</main>
    </div>
  );
}
