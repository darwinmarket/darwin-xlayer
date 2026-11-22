import { ProofView } from "./ProofView";

export default async function Page({ params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  return (
    <div className="container page">
      <ProofView hash={hash} />
    </div>
  );
}
