import FlockClient from "./FlockClient";

export const dynamic = "force-dynamic";

export default function FlockPage({ params }: { params: { id: string } }) {
  return <FlockClient flockId={params.id} />;
}
