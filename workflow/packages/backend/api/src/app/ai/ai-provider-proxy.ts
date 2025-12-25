import {
    FastifyPluginAsyncTypebox,
    Type,
} from '@fastify/type-provider-typebox'
import { StatusCodes } from 'http-status-codes'
import { exceptionHandler } from 'workflow-server-shared'
import { EnginePrincipal, PrincipalType } from 'workflow-shared'
import { BillingUsageType, usageService } from '../ee/platform-billing/usage/usage-service'
import { projectService } from '../project/project-service'
import { aiProviderService } from './ai-provider.service'

// --- SECURITY CONSTANTS ---
const ALLOWED_AI_HOSTS = [
    'api.openai.com',
    'api.anthropic.com',
    'api.cohere.ai',
    'api.google.com',
    'api.mistral.ai',
    'api.replicate.com'
];

export const proxyController: FastifyPluginAsyncTypebox = async (
    fastify,
    _opts,
) => {
    fastify.all('/:provider/*', ProxyRequest, async (request, reply) => {
        const { provider } = request.params
        const { projectId } = request.principal as EnginePrincipal

        const platformId = await projectService.getPlatformId(projectId)
        const aiProvider = await aiProviderService.getOrThrow({
            platformId,
            provider,
            projectId,
        })
        
        const exceededLimit = await usageService(request.log).aiTokensExceededLimit(projectId, 0)
        if (exceededLimit) {
            return reply.code(StatusCodes.PAYMENT_REQUIRED).send(
                makeOpenAiResponse(
                    'You have exceeded your AI tokens limit for this project.',
                    'ai_tokens_limit_exceeded',
                    {},
                ),
            )
        }

        // --- SECURITY VALIDATION START ---
        const url = buildUrl(aiProvider.baseUrl, request.params['*'])
        const parsedUrl = new URL(url);

        // Security Check: Ensure the destination is in our trusted allowlist
        if (!ALLOWED_AI_HOSTS.includes(parsedUrl.hostname)) {
            request.log.warn({ hostname: parsedUrl.hostname }, 'SSRF Attempt Blocked');
            return reply.code(StatusCodes.FORBIDDEN).send({
                error: "Security Violation: Access to the requested host is restricted."
            });
        }
        // --- SECURITY VALIDATION END ---

        try {
            const cleanHeaders = calculateHeaders(
                request.headers as Record<string, string | string[] | undefined>,
                aiProvider.config.defaultHeaders,
            )
            const response = await fetch(url, {
                method: request.method,
                headers: cleanHeaders,
                body: JSON.stringify(request.body),
                // Security Note: In a production environment, consider setting redirect: 'error'
                // to prevent redirect-based SSRF bypasses.
                redirect: 'error' 
            })

            const responseContentType = response.headers.get('content-type')
            const data = await parseResponseData(response, responseContentType)

            await usageService(request.log).increaseProjectAndPlatformUsage({ 
                projectId, 
                incrementBy: 1, 
                usageType: BillingUsageType.AI_TOKENS 
            })

            await reply.code(response.status).type(responseContentType ?? 'text/plain').send(data)
        }
        catch (error) {
            if (error instanceof Response) {
                const errorData = await error.json()
                await reply.code(error.status).send(errorData)
            }
            else {
                exceptionHandler.handle(error, request.log)
                await reply
                    .code(500)
                    .send({ message: 'An unexpected error occurred in the proxy' })
            }
        }
    })
}

// ... (Rest of the helper functions: parseResponseData, makeOpenAiResponse, buildUrl, calculateHeaders)
// Ensure buildUrl remains as you provided it, as it already validates protocols.
