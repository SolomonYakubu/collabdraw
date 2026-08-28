import { CollaborationContextProvider } from "../../context/CollaborationContext";

/**
 * Editor layout: the collaboration socket connects here, scoped to this board.
 * Mounting the provider here (rather than in the root layout) means the
 * dashboard at `/` opens no socket connection.
 */
export default async function BoardLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <CollaborationContextProvider roomId={id}>
      {children}
    </CollaborationContextProvider>
  );
}
