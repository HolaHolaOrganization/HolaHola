[CmdletBinding()]
param([switch]$SkipMutationChecks)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

. (Join-Path $PSScriptRoot 'hola-coordinator.ps1')

$diagnosticResults = @{}
$diagnosticCase = $null
$diagnosticChecks = @()
function Start-DiagnosticCase {
    param([ValidatePattern('^[a-zA-Z0-9._/-]+$')][string]$Id)
    if ($null -ne $script:diagnosticCase -or $script:diagnosticResults.ContainsKey($Id)) {
        throw 'Duplicate or unfinished diagnostic case'
    }
    $script:diagnosticCase = $Id
    $script:diagnosticChecks = @()
}
function Write-DiagnosticCase {
    param([ValidateSet('PASS', 'FAIL')][string]$Status)
    $record = [ordered]@{
        case = $script:diagnosticCase
        status = $Status
        checks = @($script:diagnosticChecks)
    }
    # Only fixed fixture IDs and outcomes. Never include observed values/errors.
    Write-Host ('[coordinator-v2] diagnostic-result ' + (ConvertTo-Json -InputObject $record -Depth 4 -Compress))
    $script:diagnosticResults[$script:diagnosticCase] = $Status
    $script:diagnosticCase = $null
}
function Complete-DiagnosticCase {
    if ($null -eq $script:diagnosticCase -or $script:diagnosticChecks.Count -eq 0) {
        throw 'Empty or missing diagnostic case'
    }
    Write-DiagnosticCase 'PASS'
}
function Assert-Diagnostic {
    param([bool]$Condition, [string]$Message,
        [Parameter(Mandatory)][ValidatePattern('^[a-z0-9-]+$')][string]$Check)
    if ($null -eq $script:diagnosticCase -or @($script:diagnosticChecks | Where-Object { $_.name -ceq $Check }).Count -gt 0) {
        throw 'Missing diagnostic case or duplicate assertion ID'
    }
    $script:diagnosticChecks += [ordered]@{ name = $Check; status = $(if ($Condition) { 'PASS' } else { 'FAIL' }) }
    if (-not $Condition) {
        Write-DiagnosticCase 'FAIL'
        throw $Message
    }
}

# Pure synthetic error objects: no DPAPI, key, filesystem or network operations.
$sentinel = 'SYNTHETIC_SECRET_NEVER_REPORT_75319'
function New-DiagnosticFixture {
    param($Status = 409, $Body = '', [switch]$StreamOnly, [switch]$BrokenStream)
    $response = [pscustomobject]@{ StatusCode = $Status; FixtureBody = $Body }
    if ($StreamOnly) {
        $response | Add-Member ScriptMethod GetResponseStream {
            return [IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes([string]$this.FixtureBody))
        }
    }
    if ($BrokenStream) {
        $response | Add-Member ScriptMethod GetResponseStream { throw 'SYNTHETIC_SECRET_NEVER_REPORT_75319' }
    }
    return [pscustomobject]@{
        Exception = [pscustomobject]@{ Response = $response; Message = $sentinel }
        ErrorDetails = [pscustomobject]@{ Message = $(if ($StreamOnly -or $BrokenStream) { '' } else { $Body }) }
    }
}

$cases = @(
    @{ body = '{"error":{"code":"V2_HOST_REAUTH_GENERATION_CONFLICT","message":"' + $sentinel + '"}}'
       id = 'generation-conflict'; reason = 'V2_HOST_REAUTH_GENERATION_CONFLICT' },
    @{ body = '{"error":{"code":"V2_HOST_REAUTH_PENDING_CONFLICT"},"accessToken":"' + $sentinel + '"}'
       id = 'pending-conflict'; reason = 'V2_HOST_REAUTH_PENDING_CONFLICT' },
    @{ id = 'enrollment-revoked'; body = '{"error":{"code":"V2_HOST_ENROLLMENT_REVOKED"}}'; reason = 'V2_HOST_ENROLLMENT_REVOKED' },
    @{ id = 'founder-required'; body = '{"error":{"code":"V2_HOST_FOUNDER_REQUIRED"}}'; reason = 'V2_HOST_FOUNDER_REQUIRED' },
    @{ id = 'database-unavailable'; body = '{"error":{"code":"V2_HOST_DATABASE_UNAVAILABLE"}}'; reason = 'V2_HOST_DATABASE_UNAVAILABLE' },
    @{ id = 'unknown-code'; body = '{"error":{"code":"' + $sentinel + '"}}'; reason = 'UNKNOWN_SERVER_ERROR' },
    @{ id = 'lowercase-code'; body = '{"error":{"code":"v2_host_reauth_generation_conflict"}}'; reason = 'UNKNOWN_SERVER_ERROR' },
    @{ id = 'numeric-code'; body = '{"error":{"code":409}}'; reason = 'UNKNOWN_SERVER_ERROR' },
    @{ id = 'null-code'; body = '{"error":{"code":null}}'; reason = 'UNKNOWN_SERVER_ERROR' },
    @{ id = 'null-error'; body = '{"error":null}'; reason = 'UNKNOWN_SERVER_ERROR' },
    @{ id = 'null-root'; body = 'null'; reason = 'UNKNOWN_SERVER_ERROR' },
    @{ id = 'empty-array'; body = '[]'; reason = 'UNKNOWN_SERVER_ERROR' },
    @{ id = 'root-array'; body = '[{"error":{"code":"V2_HOST_REAUTH_GENERATION_CONFLICT"}}]'; reason = 'UNKNOWN_SERVER_ERROR' },
    @{ id = 'malformed-json'; body = '{"error":'; reason = 'UNKNOWN_SERVER_ERROR' },
    @{ id = 'html'; body = '<html>' + $sentinel + '</html>'; reason = 'UNKNOWN_SERVER_ERROR' },
    @{ body = (' ' * 4097) + '{"error":{"code":"V2_HOST_REAUTH_GENERATION_CONFLICT"}}'
       id = 'oversized'; reason = 'RESPONSE_TOO_LARGE' }
)
foreach ($case in $cases) {
    foreach ($streamOnly in @($false, $true)) {
        $capture = if ($streamOnly) { 'legacy-stream' } else { 'error-details' }
        Start-DiagnosticCase ('recovery/' + $case.id + '/' + $capture)
        $fixture = New-DiagnosticFixture -Body $case.body -StreamOnly:$streamOnly
        $detail = Get-HolaCoordinatorRecoveryFailureDetail -ErrorRecord $fixture
        Assert-Diagnostic ($detail -match ('reason=' + $case.reason + ';')) 'Wrong bounded reason' -Check 'reason-allowlist'
        Assert-Diagnostic ($detail -match '^http_status=409;') 'HTTP status missing' -Check 'http-status'
        Assert-Diagnostic ($detail.Length -le 300) 'Report exceeds Fail-Safe detail bound' -Check 'detail-bound'
        Assert-Diagnostic ($detail -notmatch $sentinel) 'Secret reflected into diagnostics' -Check 'sentinel-confidentiality'
        Assert-Diagnostic ($detail -notmatch 'accessToken|<html>|response=|message=') 'Raw error content reflected' -Check 'raw-content-exclusion'
        Complete-DiagnosticCase
    }
}
$body = '{"error":{"code":"V2_HOST_REAUTH_GENERATION_CONFLICT"}}'
$statusNames = @('string', 'negative', 'success', 'out-of-range', 'null', 'boolean', 'sentinel')
$statusIndex = 0
foreach ($status in @('409', -1, 200, 600, $null, $true, $sentinel)) {
    Start-DiagnosticCase ('recovery/invalid-http/' + $statusNames[$statusIndex++])
    $detail = Get-HolaCoordinatorRecoveryFailureDetail -ErrorRecord (New-DiagnosticFixture -Status $status -Body $body)
    Assert-Diagnostic ($detail -match '^http_status=none; reason=TRANSPORT_UNKNOWN;') 'Untrusted HTTP metadata accepted' -Check 'untrusted-status-rejection'
    Assert-Diagnostic ($detail -notmatch $sentinel) 'Invalid status reflected' -Check 'sentinel-confidentiality'
    Complete-DiagnosticCase
}
Start-DiagnosticCase 'recovery/broken-stream'
$detail = Get-HolaCoordinatorRecoveryFailureDetail -ErrorRecord (New-DiagnosticFixture -BrokenStream)
Assert-Diagnostic ($detail -match 'reason=DIAGNOSTIC_UNAVAILABLE;') 'Broken capture changed error behavior' -Check 'safe-fallback'
Complete-DiagnosticCase
foreach ($pair in @(
    @{ status = [Net.WebExceptionStatus]::Timeout; reason = 'TRANSPORT_TIMEOUT' },
    @{ status = [Net.WebExceptionStatus]::ConnectFailure; reason = 'TRANSPORT_CONNECTIVITY' },
    @{ status = [Net.WebExceptionStatus]::TrustFailure; reason = 'TRANSPORT_TLS' }
)) {
    Start-DiagnosticCase ('recovery/transport/' + $pair.status.ToString())
    $exception = [Net.WebException]::new($sentinel, $null, $pair.status, $null)
    $detail = Get-HolaCoordinatorRecoveryFailureDetail -ErrorRecord ([pscustomobject]@{ Exception = $exception })
    Assert-Diagnostic ($detail -match ('reason=' + $pair.reason + ';')) 'Typed transport reason missing' -Check 'typed-transport-reason'
    Assert-Diagnostic ($detail -notmatch $sentinel) 'Exception message reflected' -Check 'sentinel-confidentiality'
    Complete-DiagnosticCase
}
Start-DiagnosticCase 'recovery/unknown-guidance'
Assert-Diagnostic ($null -eq (Get-HolaCoordinatorRecoveryGuidance -Code $sentinel)) 'Unknown reason was allowlisted' -Check 'unknown-reason-rejection'
Complete-DiagnosticCase

# Enrollment is a distinct allowlist over the same bounded extraction.
# StreamOnly simulates the legacy Windows response-stream shape; running this
# elsewhere does NOT constitute native Windows PowerShell 5.1 verification.
$enrollmentCodes = @(
    'V2_HOST_BOOTSTRAP_REQUIRED', 'V2_HOST_BOOTSTRAP_DENIED', 'V2_HOST_BOOTSTRAP_UNAVAILABLE',
    'V2_HOST_BOOTSTRAP_CONSUMED', 'V2_HOST_FOUNDER_REQUIRED', 'V2_HOST_IDEMPOTENCY_CONFLICT',
    'V2_HOST_REQUEST_NOT_FOUND', 'V2_HOST_REQUEST_EXPIRED', 'V2_HOST_REQUEST_TERMINAL',
    'V2_HOST_CHALLENGE_INVALID', 'V2_HOST_CHALLENGE_EXPIRED', 'V2_HOST_PROOF_INVALID',
    'V2_HOST_INVALID_REQUEST', 'V2_HOST_PROTOCOL_MISMATCH', 'V2_HOST_SOURCE_PROMOTION_REQUIRED',
    'V2_HOST_DATABASE_UNAVAILABLE'
)
$enrollmentCases = @()
foreach ($code in $enrollmentCodes) {
    Start-DiagnosticCase ('enrollment/ordinal-guidance/' + $code)
    Assert-Diagnostic ($null -eq (Get-HolaCoordinatorEnrollmentGuidance -Code $code.ToLowerInvariant())) `
        'Enrollment guidance accepted case-insensitive reason' -Check 'ordinal-allowlist'
    Complete-DiagnosticCase
    $enrollmentCases += @{
        id = $code + '/exact'
        body = '{"error":{"code":"' + $code + '","message":"' + $sentinel + '"},"requestKey":"' +
            $sentinel + '","nonce":"' + $sentinel + '","signature":"' + $sentinel +
            '","accessToken":"' + $sentinel + '","url":"https://example.invalid/' + $sentinel + '"}'
        reason = $code
    }
    $enrollmentCases += @{
        id = $code + '/lowercase'
        body = '{"error":{"code":"' + $code.ToLowerInvariant() + '"}}'
        reason = 'UNKNOWN_SERVER_ERROR'
    }
    $enrollmentCases += @{
        id = $code + '/mixed-case'
        body = '{"error":{"code":"V2_HOST_' + $code.Substring(8).ToLowerInvariant() + '"}}'
        reason = 'UNKNOWN_SERVER_ERROR'
    }
}
$enrollmentCases += @(
    @{ id = 'recovery-generation-code'; body = '{"error":{"code":"V2_HOST_REAUTH_GENERATION_CONFLICT"}}'; reason = 'UNKNOWN_SERVER_ERROR' },
    @{ id = 'recovery-pending-code'; body = '{"error":{"code":"V2_HOST_REAUTH_PENDING_CONFLICT"}}'; reason = 'UNKNOWN_SERVER_ERROR' },
    @{ id = 'suffixed-code'; body = '{"error":{"code":"V2_HOST_BOOTSTRAP_DENIED' + $sentinel + '"}}'; reason = 'UNKNOWN_SERVER_ERROR' },
    @{ id = 'unknown-code'; body = '{"error":{"code":"' + $sentinel + '"}}'; reason = 'UNKNOWN_SERVER_ERROR' },
    @{ id = 'numeric-code'; body = '{"error":{"code":409}}'; reason = 'UNKNOWN_SERVER_ERROR' },
    @{ id = 'array-code'; body = '{"error":{"code":[]}}'; reason = 'UNKNOWN_SERVER_ERROR' },
    @{ id = 'object-code'; body = '{"error":{"code":{}}}'; reason = 'UNKNOWN_SERVER_ERROR' },
    @{ id = 'null-code'; body = '{"error":{"code":null}}'; reason = 'UNKNOWN_SERVER_ERROR' },
    @{ id = 'null-error'; body = '{"error":null}'; reason = 'UNKNOWN_SERVER_ERROR' },
    @{ id = 'array-error'; body = '{"error":[]}'; reason = 'UNKNOWN_SERVER_ERROR' },
    @{ id = 'empty-object'; body = '{}'; reason = 'UNKNOWN_SERVER_ERROR' },
    @{ id = 'null-root'; body = 'null'; reason = 'UNKNOWN_SERVER_ERROR' },
    @{ id = 'empty-array'; body = '[]'; reason = 'UNKNOWN_SERVER_ERROR' },
    @{ id = 'root-array'; body = '[{"error":{"code":"V2_HOST_BOOTSTRAP_DENIED"}}]'; reason = 'UNKNOWN_SERVER_ERROR'
       assertion = 'Enrollment malformed root array accepted' },
    @{ id = 'string-root'; body = '"V2_HOST_BOOTSTRAP_DENIED"'; reason = 'UNKNOWN_SERVER_ERROR' },
    @{ id = 'malformed-json'; body = '{"error":'; reason = 'UNKNOWN_SERVER_ERROR' },
    @{ id = 'html'; body = '<html>' + $sentinel + '</html>'; reason = 'UNKNOWN_SERVER_ERROR' },
    @{ id = 'empty-body'; body = ''; reason = 'UNKNOWN_SERVER_ERROR' },
    @{ id = 'oversized'; body = (' ' * 4097) + $sentinel; reason = 'RESPONSE_TOO_LARGE' }
)
$boundaryBody = '{"error":{"code":"V2_HOST_BOOTSTRAP_DENIED"}}'
$enrollmentCases += @{
    id = 'body-boundary-4096'
    body = $boundaryBody + (' ' * (4096 - $boundaryBody.Length)); reason = 'V2_HOST_BOOTSTRAP_DENIED'
}
$enrollmentCases += @{
    id = 'body-boundary-4097'
    body = $boundaryBody + (' ' * (4097 - $boundaryBody.Length)); reason = 'RESPONSE_TOO_LARGE'
}
foreach ($case in $enrollmentCases) {
    foreach ($streamOnly in @($false, $true)) {
        $capture = if ($streamOnly) { 'legacy-stream' } else { 'error-details' }
        Start-DiagnosticCase ('enrollment/' + $case.id + '/' + $capture)
        $fixture = New-DiagnosticFixture -Body $case.body -StreamOnly:$streamOnly
        $detail = Get-HolaCoordinatorTransportFailureDetail -ErrorRecord $fixture
        Assert-Diagnostic ($detail -notmatch $sentinel) 'Enrollment secret reflected' -Check 'sentinel-confidentiality'
        $expected = 'http_status=409; reason=' + $case.reason + '; next=' +
            (Get-HolaCoordinatorEnrollmentGuidance -Code $case.reason)
        $assertion = 'Enrollment report not fixed and allowlisted'
        if ($case.ContainsKey('assertion')) { $assertion = $case.assertion }
        Assert-Diagnostic ($detail -ceq $expected) $assertion -Check 'fixed-allowlisted-report'
        Assert-Diagnostic ($detail.Length -le 300) 'Enrollment report exceeds Fail-Safe bound' -Check 'detail-bound'
        Assert-Diagnostic ($detail -notmatch 'requestKey|accessToken|nonce|signature|https://|<html>|response=|message=') `
            'Enrollment raw error content reflected' -Check 'raw-content-exclusion'
        $observed = ''
        try { Fail-Safe 'enrollment_transport' -Detail $detail }
        catch { $observed = [string]$_.Exception.Message }
        Assert-Diagnostic ($observed -ceq ('hola_coordinator_enrollment_transport :: ' + $expected)) `
            'Enrollment failure code or detail changed at Fail-Safe boundary' -Check 'failure-prefix'
        Complete-DiagnosticCase
    }
}
foreach ($status in @([Net.HttpStatusCode]::Forbidden, [int]400, [long]599)) {
    Start-DiagnosticCase ('enrollment/typed-http/' + [string][int]$status)
    $detail = Get-HolaCoordinatorTransportFailureDetail -ErrorRecord (
        New-DiagnosticFixture -Status $status -Body $boundaryBody)
    Assert-Diagnostic ($detail -cmatch ('^http_status=' + [string][int]$status + '; reason=V2_HOST_BOOTSTRAP_DENIED;')) `
        'Typed enrollment HTTP status missing' -Check 'typed-http-status'
    Complete-DiagnosticCase
}
$statusNames = @('string', 'negative', 'success', 'out-of-range', 'null', 'boolean', 'floating-point', 'sentinel')
$statusIndex = 0
foreach ($status in @('409', -1, 200, 600, $null, $true, 409.0, $sentinel)) {
    Start-DiagnosticCase ('enrollment/invalid-http/' + $statusNames[$statusIndex++])
    # Invalid status must neither parse the body nor attempt its legacy stream.
    $fixture = New-DiagnosticFixture -Status $status -Body $boundaryBody -BrokenStream
    $detail = Get-HolaCoordinatorTransportFailureDetail -ErrorRecord $fixture
    Assert-Diagnostic ($detail -cmatch '^http_status=none; reason=TRANSPORT_UNKNOWN;') `
        'Untrusted enrollment HTTP metadata accepted' -Check 'untrusted-status-rejection'
    Assert-Diagnostic ($detail -notmatch $sentinel) 'Enrollment invalid status reflected' -Check 'sentinel-confidentiality'
    Complete-DiagnosticCase
}
foreach ($pair in @(
    @{ status = [Net.WebExceptionStatus]::Timeout; reason = 'TRANSPORT_TIMEOUT' },
    @{ status = [Net.WebExceptionStatus]::NameResolutionFailure; reason = 'TRANSPORT_CONNECTIVITY' },
    @{ status = [Net.WebExceptionStatus]::ConnectFailure; reason = 'TRANSPORT_CONNECTIVITY' },
    @{ status = [Net.WebExceptionStatus]::TrustFailure; reason = 'TRANSPORT_TLS' },
    @{ status = [Net.WebExceptionStatus]::SecureChannelFailure; reason = 'TRANSPORT_TLS' },
    @{ status = [Net.WebExceptionStatus]::UnknownError; reason = 'TRANSPORT_UNKNOWN' }
)) {
    Start-DiagnosticCase ('enrollment/transport/' + $pair.status.ToString())
    $exception = [Net.WebException]::new($sentinel, $null, $pair.status, $null)
    $detail = Get-HolaCoordinatorTransportFailureDetail -ErrorRecord ([pscustomobject]@{ Exception = $exception })
    Assert-Diagnostic ($detail -ceq ('http_status=none; reason=' + $pair.reason + '; next=' +
        (Get-HolaCoordinatorEnrollmentGuidance -Code $pair.reason))) 'Enrollment typed transport reason missing' -Check 'typed-transport-reason'
    Assert-Diagnostic ($detail -notmatch $sentinel) 'Enrollment exception message reflected' -Check 'sentinel-confidentiality'
    Complete-DiagnosticCase
}
Start-DiagnosticCase 'enrollment/broken-stream'
$detail = Get-HolaCoordinatorTransportFailureDetail -ErrorRecord (New-DiagnosticFixture -BrokenStream)
Assert-Diagnostic ($detail -cmatch '^http_status=none; reason=DIAGNOSTIC_UNAVAILABLE;') 'Enrollment failed-stream fallback wrong' -Check 'safe-fallback'
Assert-Diagnostic ($detail -notmatch $sentinel) 'Enrollment failed-stream text reflected' -Check 'sentinel-confidentiality'
Complete-DiagnosticCase
$metadataNames = @('missing', 'exception-only', 'object-body')
$metadataIndex = 0
foreach ($fixture in @(
    [pscustomobject]@{},
    [pscustomobject]@{ Exception = [Exception]::new($sentinel) },
    (New-DiagnosticFixture -Body ([pscustomobject]@{ Message = $sentinel }))
)) {
    Start-DiagnosticCase ('enrollment/malformed-metadata/' + $metadataNames[$metadataIndex++])
    $detail = Get-HolaCoordinatorTransportFailureDetail -ErrorRecord $fixture
    Assert-Diagnostic ($detail -notmatch $sentinel) 'Malformed enrollment metadata reflected' -Check 'sentinel-confidentiality'
    Assert-Diagnostic ($detail -match 'reason=(TRANSPORT_UNKNOWN|UNKNOWN_SERVER_ERROR);') 'Malformed enrollment fallback wrong' -Check 'safe-fallback'
    Complete-DiagnosticCase
}
Start-DiagnosticCase 'enrollment/unknown-guidance'
Assert-Diagnostic ($null -eq (Get-HolaCoordinatorEnrollmentGuidance -Code $sentinel)) 'Enrollment unknown reason allowlisted' -Check 'unknown-reason-rejection'
Complete-DiagnosticCase
Start-DiagnosticCase 'enrollment/recovery-guidance-exclusion'
Assert-Diagnostic ($null -eq (Get-HolaCoordinatorEnrollmentGuidance -Code 'V2_HOST_REAUTH_GENERATION_CONFLICT')) `
    'Recovery-only code leaked into enrollment allowlist' -Check 'separate-allowlists'
Complete-DiagnosticCase

# Exercise the actual public boundary without touching recovery lifecycle state.
$original = (Get-Item Function:\Restore-InternalHolaCoordinatorHostCredential).ScriptBlock
try {
    Start-DiagnosticCase 'local/recognized-failure'
    Set-Item Function:\script:Restore-InternalHolaCoordinatorHostCredential -Value {
        param($Endpoint)
        Fail-Safe 'host_credential_reauthorization_not_required'
    }
    $observed = ''
    try { Restore-HolaCoordinatorHostCredential -Endpoint 'https://example.invalid' | Out-Null }
    catch { $observed = [string]$_.Exception.Message }
    Assert-Diagnostic ($observed -match '^hola_coordinator_host_credential_reauthorization_not_required ::') `
        'Recognized local failure code changed' -Check 'failure-prefix'
    Assert-Diagnostic ($observed -match 'still valid') 'Known local failure lacks guidance' -Check 'local-guidance'
    Complete-DiagnosticCase

    Start-DiagnosticCase 'local/unexpected-failure'
    Set-Item Function:\script:Restore-InternalHolaCoordinatorHostCredential -Value {
        param($Endpoint)
        throw 'SYNTHETIC_SECRET_NEVER_REPORT_75319'
    }
    $observed = ''
    try { Restore-HolaCoordinatorHostCredential -Endpoint 'https://example.invalid' | Out-Null }
    catch { $observed = [string]$_.Exception.Message }
    Assert-Diagnostic ($observed -match '^hola_coordinator_host_recovery_failed ::') 'Unexpected local error not bounded' -Check 'failure-prefix'
    Assert-Diagnostic ($observed -notmatch $sentinel) 'Local exception text reflected' -Check 'sentinel-confidentiality'
    Complete-DiagnosticCase

    Start-DiagnosticCase 'local/transport-failure'
    Set-Item Function:\script:Restore-InternalHolaCoordinatorHostCredential -Value {
        param($Endpoint)
        $safe = Format-HolaCoordinatorRecoveryDetail -Reason 'V2_HOST_REAUTH_GENERATION_CONFLICT' -HttpStatus '409'
        Fail-Safe 'host_reauthorization_transport' -Detail $safe
    }
    $observed = ''
    try { Restore-HolaCoordinatorHostCredential -Endpoint 'https://example.invalid' | Out-Null }
    catch { $observed = [string]$_.Exception.Message }
    Assert-Diagnostic ($observed -match '^hola_coordinator_host_reauthorization_transport :: http_status=409;') `
        'Bounded transport failure lost its code or HTTP status' -Check 'failure-prefix-and-http-status'
    Assert-Diagnostic ($observed -match 'reason=V2_HOST_REAUTH_GENERATION_CONFLICT;') 'Recognized server reason lost' -Check 'reason-allowlist'
    Complete-DiagnosticCase
} finally {
    Set-Item Function:\script:Restore-InternalHolaCoordinatorHostCredential -Value $original
}
Write-Host '[coordinator-v2] Synthetic safe enrollment and recovery diagnostic checks passed'
Write-Host ('[coordinator-v2] diagnostic-result ' + (ConvertTo-Json -Compress -InputObject ([ordered]@{
    case = 'baseline-suite'; status = 'PASS'; passedCases = $diagnosticResults.Count
})))
if (-not $SkipMutationChecks) {
    & (Join-Path $PSScriptRoot 'test-hola-coordinator-enrollment-diagnostic-mutations.ps1') -VerifyChildTimeout
    & (Join-Path $PSScriptRoot 'test-hola-coordinator-enrollment-diagnostic-mutations.ps1')
    Write-Host '[coordinator-v2] diagnostic-result {"case":"complete-suite","status":"PASS"}'
} else {
    Write-Host '[coordinator-v2] diagnostic-result {"case":"mutation-suite","status":"SKIP","reason":"SkipMutationChecks"}'
}
