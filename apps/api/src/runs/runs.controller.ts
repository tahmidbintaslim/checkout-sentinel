import { createReadStream } from 'node:fs';
import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { RunRepository } from '@checkout-sentinel/db';
import type { ApiConfig } from '../config.js';
import { toRunSummaryDto } from '../monitors/monitor.mapper.js';
import { API_CONFIG, RUN_REPOSITORY } from '../tokens.js';
import { artifactContentType, locateArtifact, referencedArtifacts } from './artifacts.js';

const uuid = new ParseUUIDPipe({ version: '4' });

@ApiTags('runs')
@ApiBearerAuth()
@Controller('runs')
export class RunsController {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get(':id')
  @ApiOperation({
    summary: 'One run with its full result (result schema version 1)',
    description:
      '`artifacts` lists the screenshot and trace files the result names, for GET /runs/{id}/artifacts/{name}.',
  })
  @ApiNotFoundResponse()
  async get(@Param('id', uuid) id: string) {
    const run = await this.runs.get(id);
    if (!run) throw new NotFoundException(`Run ${id} not found`);
    return {
      ...toRunSummaryDto(run),
      artifacts: [...referencedArtifacts(run.result).values()],
      result: run.result,
    };
  }

  @Get(':id/artifacts/:name')
  @ApiOperation({
    summary: 'A screenshot (PNG) or trace (zip) of a run',
    description:
      'Only files the run result names are served, from ARTIFACTS_DIR/<monitorId>/<runId>/. Traces can hold cookies of the store session.',
  })
  @ApiProduces('image/png', 'application/zip')
  @ApiOkResponse({ description: 'The file' })
  @ApiNotFoundResponse({
    description: 'Unknown run, a name the run does not reference, or no such file',
  })
  async artifact(@Param('id', uuid) id: string, @Param('name') name: string) {
    const run = await this.runs.get(id);
    const found = run ? await locateArtifact(this.config.ARTIFACTS_DIR, run, name) : null;
    const type = artifactContentType(name);
    if (!found || !type) throw new NotFoundException(`Artifact ${name} of run ${id} not found`);
    return new StreamableFile(createReadStream(found.file), {
      type,
      length: found.size,
      disposition:
        found.ref.kind === 'trace' ? `attachment; filename="${found.ref.name}"` : 'inline',
    });
  }
}
