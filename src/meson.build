project('hanabi-extension',
  version: '42.0',
  meson_version: '>= 0.40.0'
)

sources = [
  'extension.js',
  'emulateX11WindowType.js',
  'gnomeShellOverride.js',
  'renderer.js',
  'stylesheet.css',
  'video.mp4'
]
# extra_sources = ['COPYING']
extra_sources = []

# schemas = ['io.jeffshee.github.hanabi-extension']
schemas = []

uuid = 'hanabi-extension@jeffshee.github.io'

ver_arr = meson.project_version().split('.')
if ver_arr[1].version_compare('>=0')
  shell_version = ver_arr[0]
else # pre-release (alpha, beta, rc)
  shell_version = '.'.join(ver_arr)
endif

## Global
# datadir = get_option('datadir')
# extensions_dir = join_paths(datadir, 'gnome-shell', 'extensions')
# schema_dir = join_paths(datadir, 'glib-2.0', 'schemas')

## Local
prefix = get_option('prefix')
datadir = join_paths (prefix, get_option('datadir'))
schema_dir = join_paths(datadir, 'glib-2.0', 'schemas')
extensions_dir = join_paths(prefix, 'share', 'gnome-shell', 'extensions')

have_schemas = schemas.length() > 0

metaconf = configuration_data()
metaconf.set('uuid', uuid)
metaconf.set('shell_version', shell_version)
if have_schemas
  metaconf.set('settings_schema', schemas[0])
endif

meta = [
  configure_file(
    input: 'metadata.json.in',
    output: 'metadata.json',
    configuration: metaconf
  )
]

install_data(sources + extra_sources + meta,
  install_dir: join_paths(extensions_dir, uuid)
)

foreach s : schemas
  install_data('schemas/@0@.gschema.xml'.format(s),
    install_dir: schema_dir
  )
endforeach

if have_schemas
  meson.add_install_script('meson-postinstall.sh')
endif

extension_tool = find_program('gnome-extensions', required: false)
if extension_tool.found()
  builddir = meson.current_build_dir()
  srcdir = meson.current_source_dir()

  command = [
    extension_tool,
    'pack',
    '--force',
    '--out-dir=@0@'.format(builddir),
    '--extra-source=@0@/metadata.json'.format(builddir)
  ]

  foreach s : extra_sources
    command += '--extra-source=@0@'.format(s)
  endforeach

  command += srcdir

  run_target('zip-file', command: command)
endif
