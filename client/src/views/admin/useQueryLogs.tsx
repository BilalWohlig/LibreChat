import { useState, useEffect, useRef, useCallback } from 'react';
import { EventSourcePolyfill } from 'event-source-polyfill';

// --- Type Definition ---
export interface QueryLog {
  _id: string;
  conversationId: string;
  user: { name?: string; email?: string; id?: string };
  title?: string;
  totalTokens: number;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

// --- Utility Function ---
function toConversationRow(data: any): QueryLog {
  return {
    _id: data.conversationId,
    conversationId: data.conversationId,
    user: data.user || { id: 'unknown' },
    title: data.title || 'New Chat',
    totalTokens: data.totalTokens || 0,
    messageCount: data.messageCount || 0,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt || data.createdAt,
  };
}

/**
 * Custom hook to manage fetching query logs and maintaining a real-time SSE connection
 * @param limit - Number of items per page
 * @param page - Current page number
 * @param search - Search query string
 * @returns Object with logs, connection status, total count, loading state, and error
 */
export function useQueryLogs(limit: number = 10, page: number = 1, search: string = '') {
  const esRef = useRef<EventSourcePolyfill | null>(null);
  const isClosingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const [logs, setLogs] = useState<QueryLog[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true); // Changed: Start with true for initial load
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const fetchLogs = useCallback((currentPage: number, currentLimit: number, currentSearch: string) => {
    const token = localStorage.getItem('token');
    if (!token) {
      setError('No authentication token found');
      setLoading(false);
      return;
    }

    console.log('[useQueryLogs] Fetching logs:', { currentPage, currentLimit, currentSearch });
    
    // Always show loading when fetching new data
    setLoading(true);
    setError(null);

    // Close existing SSE connection
    if (esRef.current) {
      isClosingRef.current = true;
      esRef.current.close();
      esRef.current = null;
    }

    // Abort any pending requests
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const API_BASE = import.meta.env.VITE_API_BASE_URL || '';
    const params = new URLSearchParams({
      page: currentPage.toString(),
      limit: currentLimit.toString(),
    });
    
    if (currentSearch && currentSearch.trim()) {
      params.append('search', currentSearch.trim());
    }

    console.log('[useQueryLogs] SSE URL:', `${API_BASE}/api/logs/conversations?${params}`);

    const es = new EventSourcePolyfill(`${API_BASE}/api/logs/conversations?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
      heartbeatTimeout: 60000,
    });
    esRef.current = es;

    let tempConversations: QueryLog[] = [];

    es.onopen = () => {
      console.log('[useQueryLogs] SSE connected');
      setConnected(true);
      isClosingRef.current = false;
    };

    es.onmessage = (event) => {
      if (!event.data || event.data.trim() === '') return;

      try {
        const data = JSON.parse(event.data);
        
        if (data.type === 'heartbeat') return;

        if (data.type === 'init') {
          console.log('[useQueryLogs] Init:', data);
          setTotal(data.total || 0);
          if (data.count === 0) {
            setLoading(false);
            setLogs([]);
          }
          return;
        }

        if (data.event === 'historical_conversation') {
          tempConversations.push(toConversationRow(data));
          return;
        }

        if (data.type === 'historical_complete') {
          console.log('[useQueryLogs] Complete, logs:', tempConversations.length);
          setLogs(tempConversations);
          setLoading(false); // Stop loading when data is complete
          return;
        }

        if (data.event === 'realtime_conversation') {
          const newRow = toConversationRow(data);
          if (currentPage === 1) {
            setLogs((prev) => {
              const byId = new Map(prev.map((p) => [p.conversationId, p]));
              const existed = byId.has(newRow.conversationId);
              byId.set(newRow.conversationId, newRow);
              const merged = Array.from(byId.values()).sort(
                (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
              );
              if (!existed) {
                setTotal((prevTotal) => prevTotal + 1);
              }
              return merged.slice(0, currentLimit);
            });
          }
          return;
        }
        
        if (data.event === 'conversation_update' && data.type === 'title') {
          setLogs((prev) =>
            prev.map((log) =>
              log.conversationId === data.conversationId
                ? { ...log, title: data.title || log.title, updatedAt: data.updatedAt || log.updatedAt }
                : log,
            ),
          );
          return;
        }

        if (data.event === 'conversation_update' && data.type === 'tokens') {
          setLogs((prev) =>
            prev.map((log) =>
              log.conversationId === data.conversationId
                ? {
                    ...log,
                    totalTokens: data.totalTokens || log.totalTokens,
                    messageCount: data.messageCount || log.messageCount,
                    updatedAt: data.updatedAt || log.updatedAt,
                  }
                : log,
            ),
          );
          return;
        }

        if (data.event === 'error') {
          console.error('[useQueryLogs] Server error:', data.message);
          setError(data.message || 'Unknown error');
          setLoading(false);
        }
      } catch (e) {
        console.error('[useQueryLogs] Parse error:', e);
      }
    };

    es.onerror = (err) => {
      if (isClosingRef.current) return;
      console.error('[useQueryLogs] SSE error:', err);
      setError('Failed to maintain connection.');
      setConnected(false);
      setLoading(false);
      esRef.current?.close();
      esRef.current = null;
    };
  }, []);

  useEffect(() => {
    console.log('[useQueryLogs] Effect triggered:', { page, limit, search });
    fetchLogs(page, limit, search);
  }, [page, limit, search, fetchLogs]);

  useEffect(() => {
    return () => {
      if (esRef.current) {
        console.log('[useQueryLogs] Cleanup');
        isClosingRef.current = true;
        esRef.current.close();
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  return { 
    logs, 
    connected, 
    total, 
    loading, 
    error, 
    refetch: () => fetchLogs(page, limit, search) 
  };
}