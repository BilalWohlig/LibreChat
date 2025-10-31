import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { debounce } from 'lodash';
import moment from 'moment';

// UI Components
import DataTable from '~/components/ui/DataTable';
import { SearchBar } from '~/views/admin/AdminSearchBar';
import { Pagination } from '~/components/ui/Pagination';
import { Button } from '~/components/ui/Button';

// Icons
import { ArrowLeft, Download } from 'lucide-react';

// Import the custom hook and types
import { useErrorMessages, type ErrorMessage } from './UseErrorMessages';

const ErrorMessagesView: React.FC = () => {
  const navigate = useNavigate();
  const mainContainerRef = useRef<HTMLDivElement>(null);

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const limit = 10;
  const { messages, total, loading, error, refetch } = useErrorMessages(limit, page, debouncedSearch);

  const debouncedSetSearch = useCallback(
    debounce((value: string) => {
      setDebouncedSearch(value);
      setPage(1);
    }, 500),
    [],
  );

  useEffect(() => {
    const adjustTableHeight = () => {
      if (mainContainerRef.current) {
        const windowHeight = window.innerHeight;
        const containerTop = mainContainerRef.current.getBoundingClientRect().top;
        const paginationHeight = 80;
        const bottomPadding = 20;
        const availableHeight = windowHeight - containerTop - paginationHeight - bottomPadding;
        mainContainerRef.current.style.height = `${Math.max(300, availableHeight)}px`;
      }
    };

    adjustTableHeight();
    window.addEventListener('resize', adjustTableHeight);
    return () => window.removeEventListener('resize', adjustTableHeight);
  }, []);

  const handleSearch = (searchTerm: string) => {
    setSearch(searchTerm);
    debouncedSetSearch(searchTerm);
  };

  const handlePageChange = (newPage: number) => {
    setPage(newPage);
  };

  const handleGoBack = () => {
    const previousPage = sessionStorage.getItem('previousPage');
    if (previousPage) {
      navigate(previousPage);
      return;
    }
    try {
      const raw = localStorage.getItem('LAST_CONVO_SETUP_0');
      if (raw) {
        const convoId = JSON.parse(raw)?.conversationId;
        if (convoId && convoId !== 'new') {
          navigate(`/c/${convoId}`);
          return;
        }
      }
    } catch (_) {}
    navigate('/c/new');
  };

  const handleExport = async () => {
    const token = localStorage.getItem('token');
    if (!token) {
      setExportError('No authentication token found');
      return;
    }
    setExporting(true);
    setExportError(null);
    try {
      const API_BASE = import.meta.env.VITE_API_BASE_URL || '';
      const params = new URLSearchParams();
      if (debouncedSearch && debouncedSearch.trim()) {
        params.append('search', debouncedSearch.trim());
      }

      const response = await fetch(`${API_BASE}/api/messages/errors/export?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        throw new Error(`Failed to export: ${response.statusText}`);
      }
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `error_messages-${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export error:', err);
      setExportError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setExporting(false);
    }
  };

  const columns = useMemo(
    () => [
      {
        id: 'sr',
        header: 'Sr. No.',
        meta: { size: '60px' },
        cell: ({ row }: any) => (
          <span className="text-gray-900 dark:text-gray-100">
            {(page - 1) * limit + row.index + 1}
          </span>
        ),
      },
      {
        header: 'User',
        accessorKey: 'username',
        meta: { size: '150px' },
        cell: ({ row }: any) => (
          <span className="text-gray-900 dark:text-gray-100">
            {row.original.username}
          </span>
        ),
      },
      {
        header: 'Message',
        accessorKey: 'priorMessage',
        cell: ({ row }: any) => (
          <span className="whitespace-normal text-gray-900 dark:text-gray-100">
            {row.original.priorMessage}
          </span>
        ),
      },
      {
        header: 'Error',
        accessorKey: 'text',
        cell: ({ row }: any) => {
          let message = row.original.text;
          try {
            const parsed = JSON.parse(row.original.text);
            if (parsed && parsed.info) {
              message = parsed.info;
            }
          } catch (e) {
            // Not a JSON string
          }
          return (
            <span className="whitespace-normal text-gray-900 dark:text-gray-100">
              {message}
            </span>
          );
        },
      },
      {
        header: 'Date',
        accessorKey: 'createdAt',
        meta: { size: '180px' },
        cell: ({ row }: any) => (
          <span className="text-gray-900 dark:text-gray-100">
            {moment(row.original.createdAt).format('MMM DD, YYYY h:mm A')}
          </span>
        ),
      },
    ],
    [page, limit],
  );

  return (
    <div className="flex h-full flex-col gap-4 p-4 bg-white dark:bg-gray-900">
      {/* Header */}
      <div className="mb-3 flex items-center justify-between border-b border-gray-200 pb-3 dark:border-gray-700">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={handleGoBack} className="rounded-full">
            <ArrowLeft className="h-5 w-5 text-gray-700 dark:text-gray-300" />
          </Button>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            Error Messages
          </h1>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleExport}
          disabled={exporting || loading}
          className="flex items-center gap-2"
        >
          <Download className="h-4 w-4" />
          {exporting ? 'Exporting...' : 'Export'}
        </Button>
      </div>

      {/* Search Bar */}
      <div className="flex w-full gap-2">
        <SearchBar
          search={search}
          setSearch={handleSearch}
          placeholder="Search error messages, messages and user"
          disabled={false}
        />
      </div>

      {/* Error Messages */}
      {error && (
        <div className="flex items-center justify-between rounded bg-red-100 p-2 text-red-700 dark:bg-red-900/30 dark:text-red-300">
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={refetch}>
            Retry
          </Button>
        </div>
      )}

      {exportError && (
        <div className="flex items-center justify-between rounded bg-red-100 p-2 text-red-700 dark:bg-red-900/30 dark:text-red-300">
          <span>{exportError}</span>
          <Button variant="outline" size="sm" onClick={() => setExportError(null)}>
            Dismiss
          </Button>
        </div>
      )}

      {/* Data Table Container */}
      <div ref={mainContainerRef} className="relative flex-1 min-h-0 bg-white dark:bg-gray-900">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/50 dark:bg-gray-900/50 backdrop-blur-sm z-10">
            <p className="text-gray-900 dark:text-gray-100">Loading...</p>
          </div>
        )}
        <div className="h-full overflow-auto bg-white dark:bg-gray-900">
          <DataTable 
            columns={columns} 
            data={messages} 
            showCheckboxes={false} 
            onDelete={undefined} 
          />
        </div>
      </div>

      {/* Empty State */}
      {messages.length === 0 && !loading && (
        <div className="flex h-40 w-full items-center justify-center">
          <p className="text-gray-500 dark:text-gray-400">
            {debouncedSearch ? 'No errors match your search.' : 'No error messages available.'}
          </p>
        </div>
      )}

      {/* Pagination */}
      <div className="flex-shrink-0">
        <Pagination
          page={page}
          limit={limit}
          total={total}
          onPageChange={handlePageChange}
        />
      </div>
    </div>
  );
};

export default ErrorMessagesView;