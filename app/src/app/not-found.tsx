import Link from "next/link";

export default function NotFound() {
  return (
    <div className="container page">
      <div className="card stack-s" style={{ maxWidth: 520 }}>
        <span className="eyebrow">404</span>
        <h1 className="h2">This page does not exist</h1>
        <p className="muted">The basket or transaction you are looking for may be on another deployment.</p>
        <Link href="/" className="btn" style={{ alignSelf: "flex-start" }}>
          Back to the baskets
        </Link>
      </div>
    </div>
  );
}
