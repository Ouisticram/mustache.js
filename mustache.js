/*
  mustache.js — Logic-less templates in JavaScript

  See http://mustache.github.com/ for more info.
*/

var Mustache = function() {
  var Renderer = function() {};

  Renderer.prototype = {
    otag: "{{",
    ctag: "}}",
    pragmas: {},
    buffer: [],
    pragmas_implemented: {
      "IMPLICIT-ITERATOR": true,
      "TRANSLATION-HINT": true
    },
    context: {},

    render: function(template, context, partials, in_recursion) {
      // reset buffer & set context
      if(!in_recursion) {
        this.context = context;
        this.buffer = []; // TODO: make this non-lazy
      }

      // fail fast
      if(!this.includes("", template)) {
        if(in_recursion) {
          return template;
        } else {
          this.send(template);
          return;
        }
      }

      // Branching or moving down the partial stack, save any translation mode info.
      if (this.pragmas['TRANSLATION-HINT']) {
        context['_mode'] = this.pragmas['TRANSLATION-HINT']['mode'];
      }

      template = this.render_pragmas(template);

      template = this.render_i18n(template, context, partials);

      var html = this.render_section(template, context, partials);

      var stillNeedsToRender = (html === template);

      if (stillNeedsToRender) {
        if (in_recursion) {
          return this.render_tags(html, context, partials, true);
        }

        this.render_tags(html, context, partials, false);
      } else {
        if(in_recursion) {
          return html;
        } else {
          var lines = html.split("\n");
          for (var i = 0; i < lines.length; i++) {
            this.send(lines[i]);
          }
          return;
        }
      }
    },

    /*
      Sends parsed lines
    */
    send: function(line) {
      if(line != "") {
        this.buffer.push(line);
      }
    },

    /*
      Looks for %PRAGMAS
    */
    render_pragmas: function(template) {
      // no pragmas
      if(!this.includes("%", template)) {
        return template;
      }

      var that = this;
      var regex = new RegExp(this.otag + "%([\\w-]+) ?([\\w]+=[\\w]+)?" +
            this.ctag);
      return template.replace(regex, function(match, pragma, options) {
        if(!that.pragmas_implemented[pragma]) {
          throw({message:
            "This implementation of mustache doesn't understand the '" +
            pragma + "' pragma"});
        }
        that.pragmas[pragma] = {};
        if(options) {
          var opts = options.split("=");
          that.pragmas[pragma][opts[0]] = opts[1];
        }
        return "";
        // ignore unknown pragmas silently
      });
    },

    /*
      Tries to find a partial in the curent scope and render it
    */
    render_partial: function(name, context, partials) {
      name = this.trim(name);
      if(!partials || partials[name] === undefined) {
        throw({message: "unknown_partial '" + name + "'"});
      }
      if(typeof(context[name]) != "object") {
        return this.render(partials[name], context, partials, true);
      }
      return this.render(partials[name], context[name], partials, true);
    },

    render_i18n: function(html, context, partials) {
      if (html.indexOf(this.otag + "_i") == -1) {
        return html;
      }
      var that = this;
      var regex = new RegExp(this.otag + "\\_i" + this.ctag +
        "\\s*([\\s\\S]+?)" + this.otag + "\\/i" + this.ctag, "mg");

      // for each {{_i}}{{/i}} section do...
      return html.replace(regex, function(match, content) {
        var translation_mode = undefined;
        if (that.pragmas && that.pragmas["TRANSLATION-HINT"] && that.pragmas["TRANSLATION-HINT"]['mode']) {
          translation_mode = { _mode: that.pragmas["TRANSLATION-HINT"]['mode'] };
        } else if (context['_mode']) {
          translation_mode = { _mode: context['_mode'] };
        }

        return that.render(_(content, translation_mode), context, partials, true);
      });
    },

    /*
      Renders inverted (^) and normal (#) sections
    */
    render_section: function(template, context, partials) {
      if(!this.includes("#", template) && !this.includes("^", template)) {
        return template;
      }

      var that = this;
      var regex = new RegExp("(?:^([\\s\\S]*?))?" + this.otag + "(\\^|\\#)\\s*(.+)\\s*" + this.ctag +
                    "\n*([\\s\\S]+?)" + this.otag + "\\/\\s*\\3\\s*" + this.ctag + "\\s*" +
                    "([\\s\\S]*?)(?=(?:" + this.otag + "(?:\\^|\\#)\\s*(?:.+)\\s*" + this.ctag + ")|$)", "mg");

      // for each {{#foo}}{{/foo}} section do...
      return template.replace(regex, function(match, before, type, name, content, after) {
        var renderedBefore = before ? that.render_tags(before, context, partials, true) : "",
            renderedAfter = after ? that.render_tags(after, context, partials, true) : "";

        var value = that.find(name, context);
        if(type == "^") { // inverted section
          if(!value || that.is_array(value) && value.length === 0) {
            // false or empty list, render it
            return renderedBefore + that.render(content, context, partials, true) + renderedAfter;
          } else {
            return renderedBefore + "" + renderedAfter;
          }
        } else if(type == "#") { // normal section
          if(that.is_array(value)) { // Enumerable, Let's loop!
            return renderedBefore + that.map(value, function(row) {
              return that.render(content, that.create_context(row), partials, true);
            }).join("") + renderedAfter;
          } else if(that.is_object(value)) { // Object, Use it as subcontext!
            return renderedBefore + that.render(content, that.create_context(value),
              partials, true) + renderedAfter;
          } else if(typeof value === "function") {
            // higher order section
            return renderedBefore + value.call(context, content, function(text) {
              return that.render(text, context, partials, true);
            }) + renderedAfter;
          } else if(value) { // boolean section
            return renderedBefore + that.render(content, context, partials, true) + renderedAfter;
          } else {
            return renderedBefore + "" + renderedAfter;
          }
        }
      });
    },

    /*
      Replace {{foo}} and friends with values from our view
    */
    render_tags: function(template, context, partials, in_recursion) {
      // tit for tat
      var that = this;

      var new_regex = function() {
        return new RegExp(that.otag + "(=|!|>|\\{|%)?([^\\/#\\^]+?)\\1?" +
          that.ctag + "+", "g");
      };

      var regex = new_regex();
      var tag_replace_callback = function(match, operator, name) {
        switch(operator) {
        case "!": // ignore comments
          return "";
        case "=": // set new delimiters, rebuild the replace regexp
          that.set_delimiters(name);
          regex = new_regex();
          return "";
        case ">": // render partial
          return that.render_partial(name, context, partials);
        case "{": // the triple mustache is unescaped
          return that.find(name, context);
        default: // escape the value
          return that.escape(that.find(name, context));
        }
      };
      var lines = template.split("\n");
      for(var i = 0; i < lines.length; i++) {
        lines[i] = lines[i].replace(regex, tag_replace_callback, this);
        if(!in_recursion) {
          this.send(lines[i]);
        }
      }

      if(in_recursion) {
        return lines.join("\n");
      }
    },

    set_delimiters: function(delimiters) {
      var dels = delimiters.split(" ");
      this.otag = this.escape_regex(dels[0]);
      this.ctag = this.escape_regex(dels[1]);
    },

    escape_regex: function(text) {
      // thank you Simon Willison
      if(!arguments.callee.sRE) {
        var specials = [
          '/', '.', '*', '+', '?', '|',
          '(', ')', '[', ']', '{', '}', '\\'
        ];
        arguments.callee.sRE = new RegExp(
          '(\\' + specials.join('|\\') + ')', 'g'
        );
      }
      return text.replace(arguments.callee.sRE, '\\$1');
    },

    /*
      find `name` in current `context`. That is find me a value
      from the view object
    */
    find: function(name, context) {
      name = this.trim(name);

      // Checks whether a value is thruthy or false or 0
      function is_kinda_truthy(bool) {
        return bool === false || bool === 0 || bool;
      }

      var value;
      if(is_kinda_truthy(context[name])) {
        value = context[name];
      } else if(is_kinda_truthy(this.context[name])) {
        value = this.context[name];
      }

      if(typeof value === "function") {
        return value.apply(context);
      }
      if(value !== undefined) {
        return value;
      }
      // silently ignore unkown variables
      return "";
    },

    // Utility methods

    /* includes tag */
    includes: function(needle, haystack) {
      return haystack.indexOf(this.otag + needle) != -1;
    },

    /*
      Does away with nasty characters
    */
    escape: function(s) {
      s = String(s === null ? "" : s);
      return s.replace(/&(?!\w+;)|["'<>\\]/g, function(s) {
        switch(s) {
        case "&": return "&amp;";
        case "\\": return "\\\\";
        case '"': return '&quot;';
        case "'": return '&#39;';
        case "<": return "&lt;";
        case ">": return "&gt;";
        default: return s;
        }
      });
    },

    // by @langalex, support for arrays of strings
    create_context: function(_context) {
      if(this.is_object(_context)) {
        return _context;
      } else {
        var iterator = ".";
        if(this.pragmas["IMPLICIT-ITERATOR"]) {
          iterator = this.pragmas["IMPLICIT-ITERATOR"].iterator;
        }
        var ctx = {};
        ctx[iterator] = _context;
        return ctx;
      }
    },

    is_object: function(a) {
      return a && typeof a == "object";
    },

    is_array: function(a) {
      return Object.prototype.toString.call(a) === '[object Array]';
    },

    /*
      Gets rid of leading and trailing whitespace
    */
    trim: function(s) {
      return s.replace(/^\s*|\s*$/g, "");
    },

    /*
      Why, why, why? Because IE. Cry, cry cry.
    */
    map: function(array, fn) {
      if (typeof array.map == "function") {
        return array.map(fn);
      } else {
        var r = [];
        var l = array.length;
        for(var i = 0; i < l; i++) {
          r.push(fn(array[i]));
        }
        return r;
      }
    }
  };

  return({
    name: "mustache.js",
    version: "0.3.1-dev",

    /*
      Turns a template and view into HTML
    */
    to_html: function(template, view, partials, send_fun) {
      var renderer = new Renderer();
      if(send_fun) {
        renderer.send = send_fun;
      }
      renderer.render(template, view || {}, partials);
      if(!send_fun) {
        return renderer.buffer.join("\n");
      }
    }
  });
}();
