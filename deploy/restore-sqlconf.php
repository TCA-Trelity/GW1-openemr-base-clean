<?php

/**
 * Boot-time data-loss backstop for the Railway flex deploy.
 *
 * The flex entrypoint (docker/flex/openemr.sh) decides whether OpenEMR is
 * "already installed" by reading $config from sites/default/sqlconf.php. When
 * that file is absent or ships the template default ($config = 0) — which is
 * what happens on any boot where sites/ is NOT on a persistent volume — the
 * entrypoint re-runs the installer, and Installer::load_dumpfiles() executes
 * sql/database.sql, whose `DROP TABLE IF EXISTS ...` statements wipe every
 * table (globals, patient_data, oauth clients, users) and reseed defaults.
 *
 * The primary fix is a persistent volume over sites/. This script is
 * defense-in-depth so a missing or misconfigured volume can never trigger
 * that destructive reinstall: if the database ALREADY holds a populated
 * OpenEMR schema, it reconstructs a valid sqlconf.php with $config = 1 BEFORE
 * the entrypoint reads it (the entrypoint's own rsync uses --ignore-existing,
 * so a file we pre-write survives), so the installer is skipped and the
 * existing data is preserved.
 *
 * Strictly fail-open. It writes the file only in the single dangerous case
 * (populated DB + unconfigured sqlconf). In every other case — fresh empty
 * database, DB unreachable, or an already-configured sqlconf — it does
 * nothing and lets the stock entrypoint run exactly as before. It never exits
 * non-zero, so it can never block boot.
 *
 * Escape hatch: to force a clean reinstall, drop the database (or its
 * `globals` table) first; with no data present this backstop stands down.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    AgentForge Clinical Co-Pilot
 * @copyright Copyright (c) 2026
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

const LOG_PREFIX = 'restore-sqlconf:';
const SQLCONF_PATH = '/var/www/localhost/htdocs/openemr/sites/default/sqlconf.php';

/**
 * Log a reason and exit 0. Always exit 0 — this script must never block boot.
 */
function stand_down(string $why): never
{
    fwrite(STDERR, LOG_PREFIX . ' stand down — ' . $why . "\n");
    exit(0);
}

/**
 * Render a sqlconf.php byte-compatible with Installer::write_configuration_file(),
 * with $config = 1. Values are escaped for a single-quoted PHP string literal so
 * any character in the credentials round-trips to its exact value.
 */
function render_sqlconf(string $host, string $port, string $login, string $pass, string $dbase): string
{
    $q = static fn (string $s): string => str_replace(['\\', "'"], ['\\\\', "\\'"], $s);

    return "<?php\n//  OpenEMR\n//  MySQL Config\n\n"
        . "\$host\t= '" . $q($host) . "';\n"
        . "\$port\t= '" . $q($port) . "';\n"
        . "\$login\t= '" . $q($login) . "';\n"
        . "\$pass\t= '" . $q($pass) . "';\n"
        . "\$dbase\t= '" . $q($dbase) . "';\n"
        . "\n\$sqlconf = array();\nglobal \$sqlconf;\n"
        . "\$sqlconf[\"host\"]= \$host;\n"
        . "\$sqlconf[\"port\"] = \$port;\n"
        . "\$sqlconf[\"login\"] = \$login;\n"
        . "\$sqlconf[\"pass\"] = \$pass;\n"
        . "\$sqlconf[\"dbase\"] = \$dbase;\n\n"
        . "//////////////////////////\n//////////////////////////\n//////////////////////////\n"
        . "//////DO NOT TOUCH THIS///\n\$config = 1; /////////////\n"
        . "//////////////////////////\n//////////////////////////\n//////////////////////////\n?>\n";
}

/**
 * The boot-time backstop flow. Wrapped so the file can be required for testing
 * render_sqlconf() without running any of the database / filesystem logic.
 */
function main(): void
{
$host  = getenv('MYSQL_HOST') ?: 'mysql';
$port  = getenv('MYSQL_PORT') ?: '3306';
$login = getenv('MYSQL_USER') ?: 'openemr';
$pass  = getenv('MYSQL_PASS') ?: 'openemr';
$dbase = getenv('MYSQL_DATABASE') ?: 'openemr';

// (1) If a valid, already-configured sqlconf.php is present (persistent volume
// doing its job), leave it untouched. Read the flag by inspecting the file text
// rather than require()-ing it, so a half-written file can't fatal this script.
$existing = @file_get_contents(SQLCONF_PATH);
if ($existing !== false && preg_match('/\$config\s*=\s*1\s*;/', $existing) === 1) {
    stand_down('sqlconf already reports config=1 — nothing to do');
}

// (2) Is the database already populated with a real OpenEMR schema? Connect as
// the same app user the runtime will use. Distinguish "server not ready yet"
// (retry briefly) from "access denied / unknown database" (a genuinely fresh
// install — stand down immediately so the installer can provision it).
mysqli_report(MYSQLI_REPORT_OFF);
$db = false;
$deadline = time() + 20;
while (true) {
    try {
        $db = @mysqli_connect($host, $login, $pass, $dbase, (int) $port);
    } catch (\Throwable) {
        $db = false;
    }
    if ($db instanceof mysqli) {
        break;
    }
    $errno = mysqli_connect_errno();
    // 1044 access denied to db, 1045 access denied, 1049 unknown database:
    // no app user / DB yet → fresh install, let the installer create it.
    if (in_array($errno, [1044, 1045, 1049], true)) {
        stand_down('access denied / unknown database — fresh install, installer will provision');
    }
    if (time() >= $deadline) {
        stand_down('database not reachable within window — deferring to installer');
    }
    sleep(2);
}

$result = @mysqli_query($db, 'SELECT COUNT(*) AS c FROM `globals`');
if ($result === false) {
    stand_down('no globals table — treating as fresh install');
}
$row = mysqli_fetch_assoc($result);
$count = (int) ($row['c'] ?? 0);
mysqli_close($db);
if ($count <= 0) {
    stand_down('globals table empty — treating as fresh install');
}

// (3) Populated DB + unconfigured sqlconf: reconstruct the config so the flex
// entrypoint skips the destructive reinstall and the existing data survives.
$dir = dirname(SQLCONF_PATH);
if (!is_dir($dir) && !@mkdir($dir, 0o755, true) && !is_dir($dir)) {
    stand_down('could not create ' . $dir);
}
if (@file_put_contents(SQLCONF_PATH, render_sqlconf($host, $port, $login, $pass, $dbase)) === false) {
    stand_down('could not write ' . SQLCONF_PATH);
}
@chmod(SQLCONF_PATH, 0o644);

fwrite(
    STDERR,
    LOG_PREFIX . ' populated DB detected (' . $count . ' globals rows) — wrote sqlconf.php with'
    . " config=1 to skip destructive reinstall and preserve existing data\n"
);
exit(0);
}

// Run the boot logic only when invoked directly; stays inert when required by a test.
if (PHP_SAPI === 'cli' && isset($argv[0]) && realpath($argv[0]) === realpath(__FILE__)) {
    main();
}
