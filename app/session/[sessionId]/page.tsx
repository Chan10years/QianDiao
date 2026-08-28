import { SessionShell } from "@/components/session/session-shell";

export default async function SessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;

  return <SessionShell sessionId={sessionId} />;
}
