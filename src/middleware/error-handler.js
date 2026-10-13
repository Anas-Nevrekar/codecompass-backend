export function errorHandler(error, _req, res, _next) {
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
  if (process.env.NODE_ENV !== 'test') console.error(error);
  res.status(status).json({
    error: {
      code: status === 500 ? 'INTERNAL_SERVER_ERROR' : (error.code ?? 'REQUEST_ERROR'),
      message: status === 500 ? 'An unexpected error occurred' : error.message
    }
  });
}
