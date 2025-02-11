// READCODE-type core
import {
  AsyncSeriesWaterfallHook,
  SyncWaterfallHook,
} from '@umijs/bundler-utils/compiled/tapable';
import { chalk, lodash, yParser } from '@umijs/utils';
import assert from 'assert';
import { existsSync } from 'fs';
import { isAbsolute, join } from 'path';
import { Config } from '../config/config';
import { DEFAULT_FRAMEWORK_NAME } from '../constants';
import {
  ApplyPluginsType,
  ConfigChangeType,
  EnableBy,
  Env,
  IEvent,
  IFrameworkType,
  IModify,
  PluginType,
  ServiceStage,
} from '../types';
import { Command } from './command';
import { loadEnv } from './env';
import { Generator } from './generator';
import { Hook } from './hook';
import { getPaths } from './path';
import { Plugin } from './plugin';
import { PluginAPI } from './pluginAPI';

interface IOpts {
  cwd: string;
  env: Env;
  plugins?: string[];
  presets?: string[];
  frameworkName?: string;
  defaultConfigFiles?: string[];
}

export class Service {
  private opts: IOpts;
  appData: {
    deps?: Record<
      string,
      {
        version: string;
        matches: string[];
        subpaths: string[];
        external?: boolean;
      }
    >;
    framework?: IFrameworkType;
    [key: string]: any;
  } = {};
  args: yParser.Arguments = { _: [], $0: '' };
  commands: Record<string, Command> = {};
  generators: Record<string, Generator> = {};
  config: Record<string, any> = {};
  configSchemas: Record<string, any> = {};
  configDefaults: Record<string, any> = {};
  configOnChanges: Record<string, any> = {};
  cwd: string;
  env: Env;
  hooks: Record<string, Hook[]> = {};
  name: string = '';
  paths: {
    cwd?: string;
    absSrcPath?: string;
    absPagesPath?: string;
    absApiRoutesPath?: string;
    absTmpPath?: string;
    absNodeModulesPath?: string;
    absOutputPath?: string;
  } = {};
  // preset is plugin with different type
  plugins: Record<string, Plugin> = {};
  keyToPluginMap: Record<string, Plugin> = {};
  pluginMethods: Record<string, { plugin: Plugin; fn: Function }> = {};
  skipPluginIds: Set<string> = new Set<string>();
  stage: ServiceStage = ServiceStage.uninitialized;
  userConfig: Record<string, any> = {};
  configManager: Config | null = null;
  pkg: {
    name?: string;
    version?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    [key: string]: any;
  } = {};
  pkgPath: string = '';

  // READCODE 构造函数赋值cwd env opt，断言cwd是否存在
  constructor(opts: IOpts) {
    this.cwd = opts.cwd;
    this.env = opts.env;
    this.opts = opts;
    // READCODE nodejs api assert 断言 assert(这个参数为false会抛出异常并提示,这个参数是提示)
    assert(existsSync(this.cwd), `Invalid cwd ${this.cwd}, it's not found.`);
  }

  // READCODE 应用插件函数，通过重载来实现事件同步
  // overload, for apply event synchronously
  applyPlugins<T>(opts: {
    key: string;
    type?: ApplyPluginsType.event;
    initialValue?: any;
    args?: any;
    sync: true;
  }): typeof opts.initialValue | T;
  applyPlugins<T>(opts: {
    key: string;
    type?: ApplyPluginsType;
    initialValue?: any;
    args?: any;
  }): Promise<typeof opts.initialValue | T>;
  applyPlugins<T>(opts: {
    key: string;
    type?: ApplyPluginsType;
    initialValue?: any;
    args?: any;
    sync?: boolean;
  }): Promise<typeof opts.initialValue | T> | (typeof opts.initialValue | T) {
    const hooks = this.hooks[opts.key] || [];
    let type = opts.type;
    // guess type from key
    if (!type) {
      if (opts.key.startsWith('on')) {
        type = ApplyPluginsType.event;
      } else if (opts.key.startsWith('modify')) {
        type = ApplyPluginsType.modify;
      } else if (opts.key.startsWith('add')) {
        type = ApplyPluginsType.add;
      } else {
        throw new Error(
          `Invalid applyPlugins arguments, type must be supplied for key ${opts.key}.`,
        );
      }
    }
    switch (type) {
      case ApplyPluginsType.add:
        assert(
          !('initialValue' in opts) || Array.isArray(opts.initialValue),
          `applyPlugins failed, opts.initialValue must be Array if opts.type is add.`,
        );
        const tAdd = new AsyncSeriesWaterfallHook(['memo']);
        for (const hook of hooks) {
          if (!this.isPluginEnable(hook)) continue;
          tAdd.tapPromise(
            {
              name: hook.plugin.key,
              stage: hook.stage || 0,
              before: hook.before,
            },
            async (memo: any) => {
              const dateStart = new Date();
              const items = await hook.fn(opts.args);
              hook.plugin.time.hooks[opts.key] ||= [];
              hook.plugin.time.hooks[opts.key].push(
                new Date().getTime() - dateStart.getTime(),
              );
              return memo.concat(items);
            },
          );
        }
        return tAdd.promise(opts.initialValue || []) as Promise<T>;
      case ApplyPluginsType.modify:
        const tModify = new AsyncSeriesWaterfallHook(['memo']);
        for (const hook of hooks) {
          if (!this.isPluginEnable(hook)) continue;
          tModify.tapPromise(
            {
              name: hook.plugin.key,
              stage: hook.stage || 0,
              before: hook.before,
            },
            async (memo: any) => {
              const dateStart = new Date();
              const ret = await hook.fn(memo, opts.args);
              hook.plugin.time.hooks[opts.key] ||= [];
              hook.plugin.time.hooks[opts.key].push(
                new Date().getTime() - dateStart.getTime(),
              );
              return ret;
            },
          );
        }
        return tModify.promise(opts.initialValue) as Promise<T>;
      case ApplyPluginsType.event:
        if (opts.sync) {
          const tEvent = new SyncWaterfallHook(['_']);
          hooks.forEach((hook) => {
            if (this.isPluginEnable(hook)) {
              tEvent.tap(
                {
                  name: hook.plugin.key,
                  stage: hook.stage || 0,
                  before: hook.before,
                },
                () => {
                  const dateStart = new Date();
                  hook.fn(opts.args);
                  hook.plugin.time.hooks[opts.key] ||= [];
                  hook.plugin.time.hooks[opts.key].push(
                    new Date().getTime() - dateStart.getTime(),
                  );
                },
              );
            }
          });

          return tEvent.call(1) as T;
        }

        const tEvent = new AsyncSeriesWaterfallHook(['_']);
        for (const hook of hooks) {
          if (!this.isPluginEnable(hook)) continue;
          tEvent.tapPromise(
            {
              name: hook.plugin.key,
              stage: hook.stage || 0,
              before: hook.before,
            },
            async () => {
              const dateStart = new Date();
              await hook.fn(opts.args);
              hook.plugin.time.hooks[opts.key] ||= [];
              hook.plugin.time.hooks[opts.key].push(
                new Date().getTime() - dateStart.getTime(),
              );
            },
          );
        }
        return tEvent.promise(1) as Promise<T>;
      default:
        throw new Error(
          `applyPlugins failed, type is not defined or is not matched, got ${opts.type}.`,
        );
    }
  }

  // READCODE 运行函数
  async run(opts: { name: string; args?: any }) {
    const { name, args = {} } = opts;
    args._ = args._ || [];
    // READCODE 删除自己的命令参数，如umi dev要去掉dev这个参数
    // shift the command itself
    if (args._[0] === name) args._.shift();
    this.args = args;
    this.name = name;

    // READCODE init阶段
    // loadEnv
    this.stage = ServiceStage.init;
    // READCODE 加载环境，通过.env文件
    loadEnv({ cwd: this.cwd, envFile: '.env' });
    // READCODE 获取pkg的路径和json对象
    // get pkg from package.json
    let pkg: Record<string, string | Record<string, any>> = {};
    let pkgPath: string = '';
    try {
      // READCODE 这里可以提炼优化
      pkg = require(join(this.cwd, 'package.json'));
      pkgPath = join(this.cwd, 'package.json');
    } catch (_e) {
      // APP_ROOT
      if (this.cwd !== process.cwd()) {
        try {
          pkg = require(join(process.cwd(), 'package.json'));
          pkgPath = join(process.cwd(), 'package.json');
        } catch (_e) {}
      }
    }
    this.pkg = pkg;
    this.pkgPath = pkgPath || join(this.cwd, 'package.json');

    const prefix = this.opts.frameworkName || DEFAULT_FRAMEWORK_NAME;
    // READCODE 获取用户配置
    // get user config
    const configManager = new Config({
      cwd: this.cwd,
      env: this.env,
      defaultConfigFiles: this.opts.defaultConfigFiles,
      specifiedEnv: process.env[`${prefix}_ENV`.toUpperCase()],
    });

    this.configManager = configManager;
    this.userConfig = configManager.getUserConfig().config;
    // READCODE 通过cwd、环境、前缀获取一系列路径
    // get paths
    const paths = getPaths({
      cwd: this.cwd,
      env: this.env,
      prefix: this.opts.frameworkName || DEFAULT_FRAMEWORK_NAME,
    });
    // temporary paths for use by function generateFinalConfig.
    // the value of paths may be updated by plugins later
    this.paths = paths;

    // READCODE 解析初始预设和插件
    // resolve initial presets and plugins
    const { plugins, presets } = Plugin.getPluginsAndPresets({
      cwd: this.cwd,
      pkg,
      plugins: [require.resolve('./generatePlugin')].concat(
        this.opts.plugins || [],
      ),
      presets: [require.resolve('./servicePlugin')].concat(
        this.opts.presets || [],
      ),
      userConfig: this.userConfig,
      prefix,
    });
    // READCODE initPresets阶段
    // register presets and plugins
    this.stage = ServiceStage.initPresets;
    const presetPlugins: Plugin[] = [];
    // READCODE 通过while循环加载预设，长度为0停止循环
    while (presets.length) {
      await this.initPreset({
        preset: presets.shift()!,
        presets,
        plugins: presetPlugins,
      });
    }
    // READCODE 预设的插件插入到插件中
    plugins.unshift(...presetPlugins);
    // READCODE initPlugins阶段
    this.stage = ServiceStage.initPlugins;
    while (plugins.length) {
      await this.initPlugin({ plugin: plugins.shift()!, plugins });
    }
    // READCODE 检查命令是不是注册了的
    const command = this.commands[name];
    assert(command, `Invalid command ${name}, it's not registered.`);
    // collect configSchemas and configDefaults
    for (const id of Object.keys(this.plugins)) {
      const { config, key } = this.plugins[id];
      if (config.schema) this.configSchemas[key] = config.schema;
      if (config.default !== undefined) {
        this.configDefaults[key] = config.default;
      }
      this.configOnChanges[key] = config.onChange || ConfigChangeType.reload;
    }
    // READCODE 应用配置阶段
    // setup api.config from modifyConfig and modifyDefaultConfig
    this.stage = ServiceStage.resolveConfig;
    const { config, defaultConfig } = await this.resolveConfig();
    if (this.config.outputPath) {
      paths.absOutputPath = isAbsolute(this.config.outputPath)
        ? this.config.outputPath
        : join(this.cwd, this.config.outputPath);
    }
    this.paths = await this.applyPlugins({
      key: 'modifyPaths',
      initialValue: paths,
    });
    // READCODE 连接app数据阶段
    // applyPlugin collect app data
    // TODO: some data is mutable
    this.stage = ServiceStage.collectAppData;
    this.appData = await this.applyPlugins({
      key: 'modifyAppData',
      initialValue: {
        // base
        cwd: this.cwd,
        pkg,
        pkgPath,
        plugins,
        presets,
        name,
        args,
        // config
        userConfig: this.userConfig,
        mainConfigFile: configManager.mainConfigFile,
        config,
        defaultConfig: defaultConfig,
        // TODO
        // moduleGraph,
        // routes,
        // npmClient,
        // nodeVersion,
        // gitInfo,
        // gitBranch,
        // debugger info,
        // devPort,
        // devHost,
        // env
      },
    });
    // READCODE 检测阶段
    // applyPlugin onCheck
    this.stage = ServiceStage.onCheck;
    await this.applyPlugins({
      key: 'onCheck',
    });
    // READCODE 开始
    // applyPlugin onStart
    this.stage = ServiceStage.onStart;
    await this.applyPlugins({
      key: 'onStart',
    });
    // READCODE 运行命令阶段
    // run command
    this.stage = ServiceStage.runCommand;
    let ret = await command.fn({ args });
    this._baconPlugins();
    return ret;
  }

  // READCODE 返回配置和默认配置
  async resolveConfig() {
    // configManager and paths are not available until the init stage
    assert(
      this.stage > ServiceStage.init,
      `Can't generate final config before init stage`,
    );

    const resolveMode = this.commands[this.name].configResolveMode;
    const config = await this.applyPlugins({
      key: 'modifyConfig',
      // why clone deep?
      // user may change the config in modifyConfig
      // e.g. memo.alias = xxx
      initialValue: lodash.cloneDeep(
        resolveMode === 'strict'
          ? this.configManager!.getConfig({
              schemas: this.configSchemas,
            }).config
          : this.configManager!.getUserConfig().config,
      ),
      args: { paths: this.paths },
    });
    const defaultConfig = await this.applyPlugins({
      key: 'modifyDefaultConfig',
      initialValue: this.configDefaults,
    });
    this.config = lodash.merge(defaultConfig, config) as Record<string, any>;

    return { config, defaultConfig };
  }

  _baconPlugins() {
    // TODO: prettier
    if (this.args.baconPlugins) {
      console.log();
      for (const id of Object.keys(this.plugins)) {
        const plugin = this.plugins[id];
        console.log(chalk.green('plugin'), plugin.id, plugin.time);
      }
    }
  }

  // READCODE 初始化预设
  async initPreset(opts: {
    preset: Plugin;
    presets: Plugin[];
    plugins: Plugin[];
  }) {
    const { presets, plugins } = await this.initPlugin({
      plugin: opts.preset,
      presets: opts.presets,
      plugins: opts.plugins,
    });
    opts.presets.unshift(...(presets || []));
    opts.plugins.push(...(plugins || []));
  }

  // READCODE 初始化插件
  async initPlugin(opts: {
    plugin: Plugin;
    presets?: Plugin[];
    plugins: Plugin[];
  }) {
    // READCODE 插件重复注册检测
    // register to this.plugins
    assert(
      !this.plugins[opts.plugin.id],
      `${opts.plugin.type} ${opts.plugin.id} is already registered by ${
        this.plugins[opts.plugin.id]?.path
      }, ${opts.plugin.type} from ${opts.plugin.path} register failed.`,
    );
    this.plugins[opts.plugin.id] = opts.plugin;

    // apply with PluginAPI
    const pluginAPI = new PluginAPI({
      plugin: opts.plugin,
      service: this,
    });
    pluginAPI.registerPresets = pluginAPI.registerPresets.bind(
      pluginAPI,
      opts.presets || [],
    );
    pluginAPI.registerPlugins = pluginAPI.registerPlugins.bind(
      pluginAPI,
      opts.plugins,
    );
    const proxyPluginAPI = PluginAPI.proxyPluginAPI({
      service: this,
      pluginAPI,
      serviceProps: [
        'appData',
        'applyPlugins',
        'args',
        'config',
        'cwd',
        'pkg',
        'pkgPath',
        'name',
        'paths',
        'userConfig',
        'env',
        'isPluginEnable',
      ],
      staticProps: {
        ApplyPluginsType,
        ConfigChangeType,
        EnableBy,
        ServiceStage,
        service: this,
      },
    });
    let dateStart = new Date();
    let ret = await opts.plugin.apply()(proxyPluginAPI);
    opts.plugin.time.register = new Date().getTime() - dateStart.getTime();
    if (opts.plugin.type === 'plugin') {
      assert(!ret, `plugin should return nothing`);
    }
    // key should be unique
    assert(
      !this.keyToPluginMap[opts.plugin.key],
      `key ${opts.plugin.key} is already registered by ${
        this.keyToPluginMap[opts.plugin.key]?.path
      }, ${opts.plugin.type} from ${opts.plugin.path} register failed.`,
    );
    this.keyToPluginMap[opts.plugin.key] = opts.plugin;
    if (ret?.presets) {
      ret.presets = ret.presets.map(
        (preset: string) =>
          new Plugin({
            path: preset,
            type: PluginType.preset,
            cwd: this.cwd,
          }),
      );
    }
    if (ret?.plugins) {
      ret.plugins = ret.plugins.map(
        (plugin: string) =>
          new Plugin({
            path: plugin,
            type: PluginType.plugin,
            cwd: this.cwd,
          }),
      );
    }
    return ret || {};
  }

  isPluginEnable(hook: Hook | string) {
    let plugin: Plugin;
    if ((hook as Hook).plugin) {
      plugin = (hook as Hook).plugin;
    } else {
      plugin = this.keyToPluginMap[hook as string];
      if (!plugin) return false;
    }
    const { id, key, enableBy } = plugin;
    if (this.skipPluginIds.has(id)) return false;
    if (this.userConfig[key] === false) return false;
    if (this.config[key] === false) return false;
    if (enableBy === EnableBy.config) {
      // TODO: 提供单独的命令用于启用插件
      // this.userConfig 中如果存在，启用
      // this.config 好了之后如果存在，启用
      // this.config 在 modifyConfig 和 modifyDefaultConfig 之后才会 ready
      // 这意味着 modifyConfig 和 modifyDefaultConfig 只能判断 api.userConfig
      // 举个具体场景:
      //   - p1 enableBy config, p2 modifyDefaultConfig p1 = {}
      //   - p1 里 modifyConfig 和 modifyDefaultConfig 仅 userConfig 里有 p1 有效，其他 p2 开启时即有效
      //   - p2 里因为用了 modifyDefaultConfig，如果 p2 是 enableBy config，需要 userConfig 里配 p2，p2 和 p1 才有效
      return key in this.userConfig || (this.config && key in this.config);
    }
    if (typeof enableBy === 'function')
      return enableBy({
        userConfig: this.userConfig,
        config: this.config,
        env: this.env,
      });
    // EnableBy.register
    return true;
  }
}

export interface IServicePluginAPI {
  appData: typeof Service.prototype.appData;
  applyPlugins: typeof Service.prototype.applyPlugins;
  args: typeof Service.prototype.args;
  config: typeof Service.prototype.config;
  cwd: typeof Service.prototype.cwd;
  generators: typeof Service.prototype.generators;
  pkg: typeof Service.prototype.pkg;
  pkgPath: typeof Service.prototype.pkgPath;
  name: typeof Service.prototype.name;
  paths: Required<typeof Service.prototype.paths>;
  userConfig: typeof Service.prototype.userConfig;
  env: typeof Service.prototype.env;
  isPluginEnable: typeof Service.prototype.isPluginEnable;

  onCheck: IEvent<null>;
  onStart: IEvent<null>;
  modifyAppData: IModify<typeof Service.prototype.appData, null>;
  modifyConfig: IModify<
    typeof Service.prototype.config,
    { paths: Record<string, string> }
  >;
  modifyDefaultConfig: IModify<typeof Service.prototype.config, null>;
  modifyPaths: IModify<typeof Service.prototype.paths, null>;

  ApplyPluginsType: typeof ApplyPluginsType;
  ConfigChangeType: typeof ConfigChangeType;
  EnableBy: typeof EnableBy;
  ServiceStage: typeof ServiceStage;

  registerPresets: (presets: any[]) => void;
  registerPlugins: (plugins: (Plugin | {})[]) => void;
}
