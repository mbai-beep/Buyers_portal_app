<#
    Dumps the shape of zRetailHQ0 so the portal's reporting queries can be
    written against real tables.

    Run this from PowerShell on a machine that can reach the SQL Server
    (the Cowork sandbox cannot - port 12866 is outside its egress allowlist).

        cd D:\AI_ML_Projects\Buyers_Portal_App
        .\scripts\dump-sqlserver-schema.ps1 -Password 'the-real-password'

    Writes docs\schema-dump.txt. That file is gitignored - send it over, or
    paste the parts that matter.
#>
param(
  [string] $ServerInstance = '38.45.94.39,12866',
  [string] $Database       = 'zRetailHQ0',
  [string] $UserId         = 'zorderai',
  [Parameter(Mandatory=$true)][string] $Password,
  [string] $OutFile        = 'docs\schema-dump.txt',
  [int]    $TopTables      = 60
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutFile) | Out-Null

$connectionString = "Server=$ServerInstance;Database=$Database;User ID=$UserId;Password=$Password;" +
                    "Encrypt=True;TrustServerCertificate=True;Connect Timeout=20"

function Invoke-Sql([string] $sql) {
  $conn = New-Object System.Data.SqlClient.SqlConnection $connectionString
  try {
    $conn.Open()
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = $sql
    $cmd.CommandTimeout = 120
    $table = New-Object System.Data.DataTable
    $table.Load($cmd.ExecuteReader())
    return $table
  } finally { $conn.Dispose() }
}

$report = New-Object System.Text.StringBuilder
function Add-Section([string] $title, $rows) {
  [void]$report.AppendLine('')
  [void]$report.AppendLine('=' * 78)
  [void]$report.AppendLine($title)
  [void]$report.AppendLine('=' * 78)
  [void]$report.AppendLine(($rows | Format-Table -AutoSize | Out-String -Width 400))
}

Write-Host "Connecting to $Database on $ServerInstance ..." -ForegroundColor Cyan

Add-Section 'SERVER' (Invoke-Sql @"
SELECT DB_NAME() AS [Database], SUSER_SNAME() AS [Login],
       SYSDATETIME() AS [ServerTime], LEFT(@@VERSION, 100) AS [Version]
"@)

Add-Section "TABLES (top $TopTables by row count)" (Invoke-Sql @"
SELECT TOP ($TopTables)
       s.name AS [Schema], t.name AS [Table],
       SUM(CASE WHEN p.index_id IN (0,1) THEN p.rows ELSE 0 END) AS [Rows]
  FROM sys.tables t
  JOIN sys.schemas s ON s.schema_id = t.schema_id
  LEFT JOIN sys.partitions p ON p.object_id = t.object_id
 GROUP BY s.name, t.name
 ORDER BY [Rows] DESC
"@)

Add-Section 'COLUMNS' (Invoke-Sql @"
SELECT TABLE_SCHEMA AS [Schema], TABLE_NAME AS [Table],
       ORDINAL_POSITION AS [#], COLUMN_NAME AS [Column],
       DATA_TYPE AS [Type], CHARACTER_MAXIMUM_LENGTH AS [Len],
       IS_NULLABLE AS [Null]
  FROM INFORMATION_SCHEMA.COLUMNS
 ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
"@)

Add-Section 'PRIMARY AND FOREIGN KEYS' (Invoke-Sql @"
SELECT fk.name AS [ForeignKey],
       OBJECT_SCHEMA_NAME(fk.parent_object_id) + '.' + OBJECT_NAME(fk.parent_object_id) AS [FromTable],
       COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS [FromColumn],
       OBJECT_SCHEMA_NAME(fk.referenced_object_id) + '.' + OBJECT_NAME(fk.referenced_object_id) AS [ToTable],
       COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS [ToColumn]
  FROM sys.foreign_keys fk
  JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
 ORDER BY [FromTable], [ForeignKey]
"@)

Add-Section 'VIEWS' (Invoke-Sql @"
SELECT TABLE_SCHEMA AS [Schema], TABLE_NAME AS [View]
  FROM INFORMATION_SCHEMA.VIEWS ORDER BY TABLE_SCHEMA, TABLE_NAME
"@)

Add-Section 'STORED PROCEDURES AND FUNCTIONS' (Invoke-Sql @"
SELECT SPECIFIC_SCHEMA AS [Schema], SPECIFIC_NAME AS [Name], ROUTINE_TYPE AS [Kind]
  FROM INFORMATION_SCHEMA.ROUTINES ORDER BY SPECIFIC_SCHEMA, SPECIFIC_NAME
"@)

$report.ToString() | Set-Content -Path $OutFile -Encoding UTF8
Write-Host "Wrote $OutFile" -ForegroundColor Green
Write-Host 'That file is gitignored. Send it over and the reporting endpoints can be written.' -ForegroundColor Yellow
