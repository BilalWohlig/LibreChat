import { useState, useEffect, useCallback } from 'react';

export interface ErrorMessage {
  _id: string;
  messageId: string;
  user: {
    name: string;
    email: string;
  };
  conversationId: string;
  text: string;
  createdAt: string;
  username: string;
  priorMessage: string | null;
}

export const useErrorMessages = (limit: number, page: number, search: string) => {
  const [messages, setMessages] = useState<ErrorMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchErrorMessages = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = localStorage.getItem('token');
      if (!token) {
        setError('No authentication token found');
        return;
      }

      const API_BASE = import.meta.env.VITE_API_BASE_URL || '';
      const params = new URLSearchParams({
        page: page.toString(),
        limit: limit.toString(),
      });
      if (search) {
        params.append('search', search);
      }

      const response = await fetch(`${API_BASE}/api/messages/errors?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.statusText}`);
      }

      const data = await response.json();
      setMessages(data.messages || []);
      setTotal(data.total || 0);
    } catch (err) {
      console.error('Error fetching error messages:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, [page, limit, search]);

  useEffect(() => {
    fetchErrorMessages();
  }, [fetchErrorMessages]);

  return { messages, total, loading, error, refetch: fetchErrorMessages };
};
