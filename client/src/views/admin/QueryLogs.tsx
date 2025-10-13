import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { debounce } from 'lodash';
import moment from 'moment';

// UI Components
import DataTable from '~/components/ui/DataTable';
import { SearchBar } from '~/views/admin/AdminSearchBar';
import { Pagination } from '~/components/ui/Pagination';
import { Button } from '~/components/ui/Button';
import QueryLogDetailsDialog from './QueryLogDetailsDialog';

// Icons
import { ArrowLeft, Info, Download } from 'lucide-react';

// Import the custom hook and types
import { useQueryLogs, type QueryLog } from './useQueryLogs';

const QueryLogs: React.FC = () => {
  const navigate = useNavigate();
  const mainContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedLog, setSelectedLog] = useState<QueryLog | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const limit = 10;
  const { logs, total, loading, error, refetch } = useQueryLogs(limit, page, debouncedSearch);

  // Debounce search separately with useCallback
  const debouncedSetSearch = useCallback(
    debounce((value: string) => {
      console.log('[QueryLogs] Debounced search applied:', value);
      setDebouncedSearch(value);
      setPage(1);
    }, 800), // 800ms debounce for smooth typing
    [],
  );

  useEffect(() => {
    return () => {
      debouncedSetSearch.cancel();
    };
  }, [debouncedSetSearch]);

  const handleSearch = (searchTerm: string) => {
    console.log('[QueryLogs] Search input changed:', searchTerm);
    setSearch(searchTerm); // Update immediately for input display
    debouncedSetSearch(searchTerm); // Debounce the API call
  };
  
  const handlePageChange = (newPage: number) => {
    console.log('[QueryLogs] Page change:', newPage);
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

  const handleExportAllConversations = async () => {
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

      const response = await fetch(`${API_BASE}/api/logs/conversations/export?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        throw new Error(`Failed to export: ${response.statusText}`);
      }
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `all-conversations-${new Date().toISOString().split('T')[0]}.csv`;
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

  useEffect(() => {
    const totalPages = Math.ceil(total / limit);
    if (totalPages > 0 && page > totalPages) {
      console.log('[QueryLogs] Reset page to 1');
      setPage(1);
    }
  }, [total, page, limit]);
  
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

  useEffect(() => {
    console.log('[QueryLogs] State:', {
      total,
      logsLength: logs.length,
      page,
      loading,
      search,
      debouncedSearch,
    });
  }, [total, logs, page, loading, search, debouncedSearch]);

  const columns = useMemo(
    () => [
      {
        id: 'index',
        header: 'No.',
        meta: { size: '60px' },
        cell: ({ row }: any) => (
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
            {(page - 1) * limit + row.index + 1}
          </span>
        ),
      },
      {
        accessorKey: 'user.name',
        header: 'Name',
        meta: { size: '150px' },
        cell: ({ row }: any) => (
          <span className="text-sm font-medium text-gray-800 dark:text-gray-200">
            {row.original.user?.name ?? 'Unknown'}
          </span>
        ),
      },
      {
        accessorKey: 'user.email',
        header: 'Email',
        meta: { size: '200px' },
        cell: ({ row }: any) => (
          <span className="text-xs text-gray-600 dark:text-gray-300">{row.original.user?.email ?? 'N/A'}</span>
        ),
      },
      {
        accessorKey: 'title',
        header: 'Title',
        meta: { size: '250px' },
        cell: ({ row }: any) => (
          <span className="block truncate text-sm text-gray-800 dark:text-gray-200" title={row.original.title}>
            {row.original.title ?? 'New Chat'}
          </span>
        ),
      },
      {
        accessorKey: 'updatedAt',
        header: 'Last Updated',
        meta: { size: '160px' },
        cell: ({ row }: any) => (
          <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
            {moment(row.original.updatedAt).format('Do MMM YY, h:mm a')}
          </span>
        ),
      },
      {
        accessorKey: 'totalTokens',
        header: 'Tokens',
        meta: { size: '100px' },
        cell: ({ row }: any) => (
          <span className="text-xs font-medium text-gray-600 dark:text-gray-300">
            {row.original.totalTokens.toLocaleString()}
          </span>
        ),
      },
      {
        id: 'info',
        header: 'Info',
        meta: { size: '80px' },
        cell: ({ row }: any) => (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => {
              setSelectedLog(row.original);
              setDialogOpen(true);
            }}
            className="h-8 w-8 rounded-full"
          >
            <Info className="h-4 w-4 text-blue-600" />
          </Button>
        ),
      },
    ],
    [page, limit],
  );

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      {/* Header */}
      <div className="mb-3 flex items-center justify-between border-b border-gray-200 dark:border-gray-700 pb-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={handleGoBack} className="rounded-full">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Query Logs</h1>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleExportAllConversations}
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
          placeholder="Search by user name, email, or title"
          disabled={false}
          inputRef={searchInputRef}
        />
      </div>
      
      {/* Error Messages */}
      {error && (
        <div className="flex items-center justify-between rounded bg-red-100 dark:bg-red-900 p-2 text-red-700 dark:text-red-300">
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={refetch}>
            Retry
          </Button>
        </div>
      )}
      
      {exportError && (
        <div className="flex items-center justify-between rounded bg-red-100 dark:bg-red-900 p-2 text-red-700 dark:text-red-300">
          <span>{exportError}</span>
          <Button variant="outline" size="sm" onClick={() => setExportError(null)}>
            Dismiss
          </Button>
        </div>
      )}
      
      {/* Table Container - EXACTLY LIKE ADMINLOGS */}
      <div ref={mainContainerRef} className="relative flex-1 min-h-0">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-white bg-opacity-50 dark:bg-gray-800 dark:bg-opacity-50 z-10">
            <svg className="animate-spin h-5 w-5 text-gray-500" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            </svg>
            <p className="ml-2 text-gray-500 dark:text-gray-400">Loading...</p>
          </div>
        )}
        {/* DataTable is always rendered but hidden behind loading overlay */}
        <div className="h-full overflow-auto">
          <DataTable
            columns={columns}
            data={logs.map((log, i) => ({ ...log, id: log._id || `${i}` }))}
            className="h-full"
            enableRowSelection={false}
            showCheckboxes={false}
            onDelete={undefined}
          />
        </div>
      </div>

      {/* Empty State - Only show when NOT loading */}
      {logs.length === 0 && !loading && (
        <div className="flex h-40 w-full items-center justify-center">
          <p className="text-gray-500 dark:text-gray-400">
            {debouncedSearch ? 'No logs match your search.' : 'No query logs available.'}
          </p>
        </div>
      )}
      
      {/* Pagination */}
      <div data-testid="pagination-container" className="flex-shrink-0">
        <Pagination
          page={page}
          limit={limit}
          total={total}
          onPageChange={handlePageChange}
          siblingCount={1}
        />
      </div>
      
      {/* Details Dialog */}
      <QueryLogDetailsDialog
        dialogOpen={dialogOpen}
        setDialogOpen={setDialogOpen}
        selectedLog={selectedLog}
      />
    </div>
  );
};

export default QueryLogs;