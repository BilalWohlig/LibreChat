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
import { ArrowLeft } from 'lucide-react';

// Import the custom hook and types
import { useErrorMessages, type ErrorMessage } from './useErrorMessages';

const ErrorMessagesView: React.FC = () => {
  const navigate = useNavigate();
  const mainContainerRef = useRef<HTMLDivElement>(null);

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);

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

  const columns = useMemo(
    () => [
      {
        id: 'sr',
        header: 'Sr. No.',
        meta: { size: '60px' },
        cell: ({ row }: any) => (
          <span>{(page - 1) * limit + row.index + 1}</span>
        ),
      },
      {
        header: 'User',
        accessorKey: 'username',
        meta: { size: '150px' },
      },
      {
        header: 'Message',
        accessorKey: 'priorMessage',
        cell: ({ row }: any) => (
          <span className="whitespace-normal">{row.original.priorMessage}</span>
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
          return <span className="whitespace-normal">{message}</span>;
        },
      },
      {
        header: 'Date',
        accessorKey: 'createdAt',
        meta: { size: '180px' },
        cell: ({ row }: any) => (
          <span>{moment(row.original.createdAt).format('MMM DD, YYYY h:mm A')}</span>
        ),
      },
    ],
    [page, limit],
  );

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <div className="mb-3 flex items-center justify-between border-b border-gray-200 pb-3 dark:border-gray-700">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={handleGoBack} className="rounded-full">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Error Messages</h1>
        </div>
      </div>

      <div className="flex w-full gap-2">
        <SearchBar
          search={search}
          setSearch={handleSearch}
          placeholder="Search error messages, messages and user"
          disabled={false}
        />
      </div>

      {error && (
        <div className="flex items-center justify-between rounded bg-red-100 p-2 text-red-700 dark:bg-red-900 dark:text-red-300">
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={refetch}>
            Retry
          </Button>
        </div>
      )}

      <div ref={mainContainerRef} className="relative flex-1 min-h-0">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-white bg-opacity-50 dark:bg-gray-800 dark:bg-opacity-50 z-10">
            <p>Loading...</p>
          </div>
        )}
        <div className="h-full overflow-auto">
          <DataTable columns={columns} data={messages} showCheckboxes={false} onDelete={undefined} />
        </div>
      </div>

      {messages.length === 0 && !loading && (
        <div className="flex h-40 w-full items-center justify-center">
          <p className="text-gray-500 dark:text-gray-400">
            {debouncedSearch ? 'No errors match your search.' : 'No error messages available.'}
          </p>
        </div>
      )}

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
