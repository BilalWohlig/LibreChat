const { stringify } = require('csv-stringify/sync');
const { logger } = require('~/config');
const moment = require('moment');

/**
 * Converts an array of log objects to CSV format with specific fields
 * @param {Array} logs - Array of log objects
 * @returns {string} - CSV string
 */
const exportLogsToCSV = (logs) => {
  try {
    // Sort logs by timestamp descending
    const sortedLogs = logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    const formattedData = sortedLogs.map(log => ({
      'Timestamp': moment(log.timestamp).isValid()
        ? moment(log.timestamp).format('Do MMMM YY, h:mm:ss a')
        : moment().format('Do MMMM YY, h:mm:ss a'),
      'Event': log.action || 'N/A',
      'Name': log.userInfo?.name || '',
      'Email': log.userInfo?.email || log.userInfo?.username || '',
      'Details': log.details?.message || log.details?.error || JSON.stringify(log.details || {})
    }));

    const csv = stringify(formattedData, {
      header: true,
      quoted: true,
      quotedEmpty: true,
      quotedString: true,
      columns: ['Timestamp', 'Event', 'Name', 'Email', 'Details']
    });

    return csv;
  } catch (error) {
    logger.error('Error exporting logs to CSV:', error);
    throw new Error('Failed to generate CSV file');
  }
};

/**
 * Converts an array of query log objects to CSV format with specific fields
 * @param {Array} queryLogs - Array of query log objects
 * @returns {string} - CSV string
 */
const exportQueryLogsToCSV = (queryLogs) => {
  try {
    // Sort logs by createdAt descending
    const sortedLogs = queryLogs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const formattedData = sortedLogs.map(log => {
      const user = log.user || {};
      const name = log.userName || user.name || '';
      const email = log.userEmail || user.email || user.username || '';

      return {
        'Name': name,
        'Email': email,
        'Timestamp': moment(log.createdAt).isValid()
          ? moment(log.createdAt).format('Do MMMM YY, h:mm:ss a')
          : moment().format('Do MMMM YY, h:mm:ss a'),
        'Type': log.role === 'assistant' ? 'Response' : 'Query',
        'Model': log.model || '',
        'Content': log.text || '',
        'Token Count': log.tokenCount || 0,
        'Role': log.role || ''
      };
    });

    const csv = stringify(formattedData, {
      header: true,
      quoted: true,
      quotedEmpty: true,
      quotedString: true,
      columns: [
        'Name',
        'Email',
        'Timestamp',
        'Type',
        'Model',
        'Content',
        'Token Count',
        'Role'
      ]
    });

    return csv;
  } catch (error) {
    logger.error('Error exporting query logs to CSV:', error);
    throw new Error('Failed to generate query logs CSV file');
  }
};

module.exports = {
  exportLogsToCSV,
  exportQueryLogsToCSV
};