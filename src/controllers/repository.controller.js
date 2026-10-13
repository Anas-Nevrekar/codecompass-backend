import { HttpError } from '../lib/http-error.js';
import { parsePublicGitHubRepositoryUrl } from '../services/github-repository-url.service.js';
import {
  fetchPublicRepository,
  importRepositoryForUser,
  listRepositoriesForUser
} from '../services/github-repository.service.js';

function repositoryResponse(repository) {
  return {
    id: repository.id,
    owner: repository.owner,
    name: repository.name,
    fullName: repository.fullName,
    htmlUrl: repository.htmlUrl,
    description: repository.description,
    defaultBranch: repository.defaultBranch,
    language: repository.language,
    visibility: repository.visibility,
    starsCount: repository.starsCount,
    forksCount: repository.forksCount,
    githubCreatedAt: repository.githubCreatedAt,
    metadataUpdatedAt: repository.metadataUpdatedAt
  };
}

export function createRepositoryController({ prisma, fetchImpl }) {
  return {
    async import(req, res, next) {
      try {
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
            Object.keys(req.body).some((key) => key !== 'url') || typeof req.body.url !== 'string') {
          throw new HttpError(400, 'INVALID_REPOSITORY_URL', 'Provide a valid public GitHub repository URL.');
        }
        const parsed = parsePublicGitHubRepositoryUrl(req.body.url);
        const metadata = await fetchPublicRepository({ ...parsed, fetchImpl });
        const result = await importRepositoryForUser({ prisma, userId: req.auth.userId, metadata });
        res.status(result.alreadyImported ? 200 : 201).json({
          success: true,
          code: result.alreadyImported ? 'REPOSITORY_ALREADY_IMPORTED' : 'REPOSITORY_IMPORTED',
          alreadyImported: result.alreadyImported,
          repository: repositoryResponse(result.repository)
        });
      } catch (error) { next(error); }
    },

    async list(req, res, next) {
      try {
        const imports = await listRepositoriesForUser(prisma, req.auth.userId);
        res.json({
          repositories: imports.map((item) => ({
            ...repositoryResponse(item.repository),
            importedAt: item.importedAt
          }))
        });
      } catch (error) { next(error); }
    }
  };
}
