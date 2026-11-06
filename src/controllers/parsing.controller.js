import { HttpError } from '../lib/http-error.js';
import { createParsingJob, parsingJobResponse } from '../services/parsing-job.service.js';
export function createParsingController({ prisma, parsingQueue, config }) {
  return {
    async start(req, res, next) {
      try {
        const result = await createParsingJob({ prisma, queue: parsingQueue, repositoryId: req.params.repositoryId, userId: req.auth.userId, indexingConfig: config.indexing });
        if (result.notFound) throw new HttpError(404, 'REPOSITORY_NOT_FOUND', 'Imported repository was not found.');
        if (result.unavailable) throw new HttpError(409, 'PARSING_SOURCE_UNAVAILABLE', 'Repository indexing must be complete and its retained clone available before parsing.');
        res.status(result.alreadyRunning ? 200 : 202).json({ success: true, alreadyRunning: result.alreadyRunning, job: parsingJobResponse(result.job) });
      } catch (error) { next(error); }
    },
    async status(req, res, next) {
      try {
        const job = await prisma.parsingJob.findFirst({ where: { id: req.params.jobId, repository: { imports: { some: { userId: req.auth.userId } } } } });
        if (!job) throw new HttpError(404, 'PARSING_JOB_NOT_FOUND', 'Parsing job was not found.');
        res.json({ job: parsingJobResponse(job) });
      } catch (error) { next(error); }
    }
  };
}
