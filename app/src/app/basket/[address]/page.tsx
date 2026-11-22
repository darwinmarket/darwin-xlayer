import { BasketView } from "./BasketView";

export default async function Page({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  return (
    <div className="container page">
      <BasketView address={address} />
    </div>
  );
}
