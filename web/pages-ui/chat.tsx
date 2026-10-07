'use client';

import { useParams } from 'next/navigation';
import { ChatPane } from '@/components/chat/chat-pane';

export function ChatPage() {
  const { id } = useParams<{ id?: string }>();
  return <ChatPane variant="page" conversationId={id}/>;
}
