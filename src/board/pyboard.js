'use babel';

import Config from '../config.js'
import Pyserial from '../connections/pyserial';
import Pytelnet from '../connections/pytelnet';
import Pysocket from '../connections/pysocket';
import Authorize from './authorize';
import Logger from '../helpers/logger.js'

var CTRL_A = '\x01' // raw repl
var CTRL_B = '\x02' // exit raw repl
var CTRL_C = '\x03' // ctrl-c
var CTRL_D = '\x04' // reset (ctrl-d)
var CTRL_E = '\x05' // paste mode (ctrl-e)
var CTRL_F = '\x06' // safe boot (ctrl-f)
var EOF = '\x04'    // end of file


//statuses
var DISCONNECTED=0
var CONNECTED=1
var FRIENDLY_REPL=2
var RAW_REPL=3
var RUNNING_FILE=4
var PASTE_MODE=5

export default class Pyboard {

  constructor(settings){
    this.connected = false
    this.connecting = false
    this.receive_buffer = ""
    this.receive_buffer_raw = Buffer(0)
    this.waiting_for = null
    this.waiting_for_cb = null
    this.waiting_for_timeout = 8000
    this.status = DISCONNECTED
    this.pingTimer = null
    this.ping_count = 0
    this.isSerial = false
    this.type = null
    this.settings = settings
    this.timeout = settings.timeout
    this.authorize = new Authorize(this)
    this.logger = new Logger('Pyboard')
    this.config = Config.constants()
    this.refreshConfig()
    this.address = null
  }

  refreshConfig(){
    this.settings.refresh()
    this.params = {
      port: 23,
      username: this.settings.username,
      password:this.settings.password,
      enpassword:"",
      timeout: this.settings.timeout,
      ctrl_c_on_connect: this.settings.ctrl_c_on_connect
    }
    if(!this.settings.auto_connect){
      this.address = this.settings.address
    }
  }
  // store the address (tcp or serial)
  setAddress(address){
    this.address = address
  }

  getCallbacks(){
    return [this.onmessage,this.onerror,this.ontimeout,this.onmessage]
  }

  startPings(interval){
    var _this = this
    this.pingTimer = setInterval(function(){
      if(_this.connection){
        _this.connection.sendPing(function(err){
          if(err){
            _this.ping_count+=1
          }else{
            _this.ping_count = 0
          }

          if(_this.ping_count > 1){ // timeout after 2 pings
            _this.ping_count = 0
            clearInterval(_this.pingTimer)
            _this.ontimeout(new Error("Connection lost"))
            _this.disconnect()
          }
        })
      }
    },interval*1000)
  }

  stopPings(){
     clearInterval(this.pingTimer)
  }

  setStatus(status){
    if(status != this.status){
      this.status = status
      if(this.statusListenerCB){
        this.statusListenerCB(status)
      }
    }
  }

  registerStatusListener(cb){
    this.statusListenerCB = cb
  }

  enter_friendly_repl(callback){
    var _this = this
    _this.send_wait_for_blocking(CTRL_B,'Type "help()" for more information.\r\n>>>',function(err){
      if(!err){
        _this.setStatus(FRIENDLY_REPL)
      }
      if(callback){
        callback(err)
      }
    })
  }

  enter_friendly_repl_wait(callback){
    var _this = this
    _this.send_wait_for(CTRL_B,'Type "help()" for more information.\r\n>>>',function(err){
      if(!err){
        _this.setStatus(FRIENDLY_REPL)
      }
      if(callback){
        callback(err)
      }
    })
  }

  enter_friendly_repl_non_blocking(callback){
    var _this = this
    _this.send(CTRL_B,function(err){
      if(!err){
        _this.setStatus(FRIENDLY_REPL)
      }
      if(callback){
        callback(err)
      }
    },2000)
  }
  // send : [Ctrl-D] ; wait for prompt ( > or OK ) 
  soft_reset(cb,timeout){
    if(!timeout){
      timeout = 5000
    }
    this.logger.info("Soft reset")
    var wait_for = this.status == RAW_REPL ? ">" : "OK"
    this.send_wait_for_blocking(CTRL_D,wait_for,cb,timeout)
  }
  // send : [Ctrl-D] ;
  soft_reset_no_follow(cb){
    this.logger.info("Soft reset no follow")
    //todo: , extra parameter not in function definition
    this.send(CTRL_D,cb,5000)
  }

  // send : [Ctrl-F]; wait for booted prompt 
  safe_boot(cb,timeout){
    var _this = this
    this.logger.info("Safe boot")
    this.send_wait_for(CTRL_F,'Type "help()" for more information.\r\n>>>',function(err){
      _this.logger.info("Safe boot done...")
      cb(err)
    },timeout)

  }
  // send : [Ctrl-C]; wait for >>> prompt
  stop_running_programs(cb){
    this.send_wait_for(CTRL_C,">>>",function(err){
      if(cb) cb(err)
    },5000)
  }

  // send : [Ctrl-C][Ctrl-C] ; wait for >>> prompt
  stop_running_programs_double(cb,timeout){
    this.send_wait_for(CTRL_C+CTRL_C,">>>",function(err){
      if(cb) cb(err)
    },timeout)
  }

  // send [Ctrl-C]
  stop_running_programs_nofollow(callback){
    this.logger.info("CTRL-C (nofollow)")
    this.send_with_enter(CTRL_C,function(){
      callback()
    })
  }

  // enter Raw Repl 
  // send [Ctrl-A]
  enter_raw_repl_no_reset(callback){
    var _this = this
      _this.flush(function(){
        _this.logger.info("Entering raw repl")
        _this.send_wait_for_blocking(CTRL_A,'raw REPL; CTRL-B to exit\r\n>',function(err){
          console.log("entered raw repl")
          if(!err){
            _this.setStatus(RAW_REPL)
          }
          console.log("CB:")
          callback(err)
        },5000)
      })
    // })
  }

  // enter Raw Repl and soft reset 
  // send [Ctrl-A] [Ctrl-D]
  enter_raw_repl(callback){
    var _this = this
    this.enter_raw_repl_no_reset(function(err){
      _this.flush(function(){
        _this.soft_reset(function(err){
            callback()
        },5000)
      })
    })
  }

  isConnecting(){
      return this.connecting && !this.connected
  }

  connect_raw(cb,onerror,ontimeout,onmessage){
    this.connect(cb,onerror,ontimeout,onmessage,true)
  }

  connect(address,callback,onerror,ontimeout,onmessage,raw){
    this.connecting = true
    this.onconnect = callback
    this.onmessage = onmessage
    this.ontimeout = ontimeout
    this.onerror = onerror
    this.address = address
    this.stopWaitingForSilent()
    this.refreshConfig()
    var _this = this
    Pyserial.isSerialPort(this.address,function(res){
      _this.isSerial = res
      if(res){
        _this.connection = new Pyserial(_this.address,_this.params)
      }else if (raw){
        _this.connection = new Pysocket(_this.address,_this.params)
      }else{
        _this.connection = new Pytelnet(_this.address,_this.params)
      }
      _this.type = _this.connection.type

      if (_this.connection.type == 'telnet') {
        _this.authorize.run(function(error){
          if(error){
            _this._disconnected()
            callback(error)
          }else{
            _this._onconnect(callback)

          }
        })
      }


      _this.connection.connect(function(){
          _this.connection.registerListener(function(mssg,raw){
            _this.receive(mssg,raw)
          })
          if (_this.connection.type != 'telnet') {
            _this._onconnect(callback)
          }
        },function(err){
          _this._disconnected()
          _this.onerror(err)
        },function(mssg){
          // Timeout callback only works properly during connect
          // after that it might trigger unneccesarily
          if(_this.isConnecting()){
            _this._disconnected()
            ontimeout(mssg,raw)
          }
        }
      )
    })
  }

  _onconnect(cb){
    var _this = this

    _this.connected = true
    _this.connection.connected = true

    _this.connecting = false

    if(_this.params.ctrl_c_on_connect && this.type != "socket"){
      _this.stop_running_programs(cb)
    }else{
      cb()
    }
    _this.startPings(5)
  }

  _disconnected(cb){
    if(this.connection){
      this.connection.disconnect(function(){
        if(cb){
          cb()
        }
      })
    }
    this.connecting = false
    this.connected = false
    this.stopPings()
  }

  // receive is called each time data is received from the connected board via serial/socket/telnet 
  receive(mssg,raw){
    this.logger.silly('Received message: '+mssg)
    if(!this.wait_for_block && typeof mssg != 'object'){
      this.onmessage(mssg)
    }
    var err_in_output = this.getErrorMessage(mssg)

    this.receive_buffer += mssg
    this.receive_buffer_raw = Buffer.concat([this.receive_buffer_raw,raw])

    this.logger.silly('Buffer length now '+this.receive_buffer.length)

    if(err_in_output != ""){
      this.logger.silly("Error in output: "+err_in_output)
      var err = new Error(err_in_output)
      if(this.waiting_for != null){
        this.stopWaitingFor(this.receive_buffer,this.receive_buffer_raw, err)
      }else{
        this.onerror(err)
      }

    }else if(this.waiting_for != null && mssg){
      this.logger.silly("Waiting for "+this.waiting_for)
      if(this.receive_buffer === undefined) this.receive_buffer = ""
      if(this.receive_buffer.indexOf("Invalid credentials, try again.") > -1){
        this._disconnected()
        this.onconnect("Invalid credentials")
        this.stopWaitingForSilent()
        this.wait_for_blocking("Login as:",function(){
          // do nothing
        })
      }

      if(this.waiting_for_type == 'length'){
        this.logger.silly("Waiting for "+this.waiting_for+", got "+this.receive_buffer.length+" so far")
        if(this.receive_buffer.length >= this.waiting_for){
          this.stopWaitingFor(this.receive_buffer,this.receive_buffer_raw)
        }
      }else if(this.receive_buffer.indexOf(this.waiting_for) > -1 || this.receive_buffer_raw.indexOf(this.waiting_for) > -1){
        var trail = this.receive_buffer.split(this.waiting_for).pop(-1)
        if(trail && trail.length > 0 && this.wait_for_block){
          this.onmessage(trail)
        }
        this.stopWaitingFor(this.receive_buffer,this.receive_buffer_raw)
      }
    }
  }

  stopWaitingForSilent(){
    clearTimeout(this.waiting_for_timer)
    this.waiting_for = null
    this.wait_for_block = false
  }

  stopWaitingFor(mssg,raw,err){
    this.logger.silly("Stopping waiting for, got message of "+mssg.length+" chars")
    this.stopWaitingForSilent()
    if(this.waiting_for_cb){
      this.logger.silly("Callback after waiting for")
      this.waiting_for_cb(err,mssg,raw)
    }else{
      this.logger.silly("No callback after waiting")
    }
  }

  disconnect(cb){
    this.disconnect_silent(cb)
    this.setStatus(DISCONNECTED)
  }

  disconnect_silent(cb){
    this._disconnected(cb)
  }

  run(filecontents,cb){
    var _this = this
    this.stop_running_programs(function(){
      _this.enter_raw_repl_no_reset(function(){
        _this.setStatus(RUNNING_FILE)

        filecontents += "\r\nimport time;time.sleep(0.1)"
        // executing code delayed (100ms) to make sure _this.wait_for(">") is executed before execution is complete
        _this.exec_raw(filecontents+"\r\n",function(){
          _this.wait_for(">",function(){
            _this.enter_friendly_repl_wait(cb)
          })
        })
      })
    })
  }

  // run a line or a block of code using paste mode
  // [Ctrl-E] <codeblock> [CR][LF] ; waitfor <lastline in codeblock>+[CR][LF]+"==="
  runblock(codeblock,cb){
    var _this = this
    this.stop_running_programs(function(){
      _this.setStatus(PASTE_MODE)
      //get the last line of the codeblock
      _this.send(CTRL_E,function(){} );
      var last_command = codeblock.split('\r\n').pop();
      _this.exec_raw_no_reset(codeblock ,function(){ 
        _this.send("\r\n" + CTRL_D,function(){} );
        _this.wait_for_blocking(last_command + "\r\n===",function(){
            cb();
        })
      })

      _this.setStatus(FRIENDLY_REPL)
    })
  }

  /* 
  *   All send methods send messages, transmit data to MCU
  */ 

  // send: <mssg> 
  send(mssg,cb){
    if(!this.connection){
      cb(new Error("No connection"))
      return
    }
    this.connection.send(mssg,cb)
  }
  //send: <mssg> [CR][LF]
  send_with_enter(mssg,cb){
    if(!this.connection){
      cb(new Error("No connection"))
      return
    }
    this.connection.send(mssg+'\r\n',cb)
  }

  send_raw(mssg,cb){
    if(!this.connection){
      cb(new Error("No connection"))
      return
    }
    this.connection.send_raw(mssg,cb)
  }

  // // send: [\x1b] + <cmd[binary]>
  // send_cmd(cmd,cb){
  //   if(!this.connection){
  //     cb(new Error("No connection"))
  //     return
  //   }
  //   var mssg = '\x1b' + cmd
  //   var data = new Buffer(mssg,"binary")
  //   this.connection.send_raw(data,cb)
  // }

  // // send: [\x1b] + <cmd[binary]> ; read response to rcv buffer, wait for string <wait_for>
  // send_cmd_read(cmd,wait_for,cb,timeout){
  //   if(typeof wait_for == "string"){
  //     wait_for = "\x1b"+wait_for
  //     wait_for = new Buffer(wait_for,"binary")
  //   }
  //   this.read(wait_for,cb,timeout)
  //   this.send_cmd(cmd)
  // }

  // // send: [\x1b] + <cmd[binary]> ; wait for string <wait_for>
  // 
  // send_cmd_wait_for(cmd,wait_for,cb,timeout){
  //   if(typeof wait_for == "string"){
  //     wait_for = "\x1b"+wait_for
  //     wait_for = new Buffer(wait_for,"binary")
  //   }
  //   this.wait_for(wait_for,cb,timeout)
  //   this.send_cmd(cmd,function(){

  //   })
  // }

  // send: cmd
  send_user_input(mssg,cb){
    this.send(mssg,cb)
  }

  // send raw mssg and wait non_blocking for the expected response
  // do not add CRLF to avoid inserting additional empty lines
  send_raw_wait_for(mssg,wait_for,cb,timeout){
    this.wait_for(wait_for,cb,timeout)
    this.send_raw(mssg);
  }

  // send mssg and wait non_blocking for the expected response
  // do not add CRLF to avoid inserting additional empty lines
  send_wait_for(mssg,wait_for,cb,timeout){
    this.wait_for(wait_for,cb,timeout)
    this.send(mssg);
  }

  // send mssg and wait_blocking for the expected response
  // do not add CRLF to avoid inserting additional empty lines
  send_wait_for_blocking(mssg,wait_for,cb,timeout){
    this.wait_for_blocking(wait_for,cb,timeout)
    this.send(mssg);
  }

  // clear rcv buffer and wait_for in blocking mode 
  wait_for_blocking(wait_for,cb,timeout,type){
    this.wait_for(wait_for,cb,timeout,type)
    this.wait_for_block = true
  }

  send_read(mssg,number,cb,timeout){
    this.read(number,cb,timeout)
    this.send_with_enter(mssg)
  }

  // clear rcv buffer and read specified number of bytes into rcv buffer 
  read(number,cb,timeout){
    this.wait_for_blocking(number,cb,timeout,'length')
  }


  // wait for the board to return a specific string or length
  // the checking logic  is part of the receive method   
  // type = 'string' : start waiting for specified string <wait_for>
  // type = 'length': start waiting for number of bytes to be received <wait_for>
  // clear (default true) indicates clearing the receive buffer at this point in time 
  wait_for(wait_for,cb,timeout,type,clear=true){
    if(!type){ type = 'string'}
    this.waiting_for_type = type
    this.wait_for_block = false
    this.waiting_for = wait_for;
    this.waiting_for_cb = cb;
    this.waiting_for_timeout = timeout;
    if(clear){
      this.receive_buffer = ""
      this.receive_buffer_raw = Buffer(0)
    }

    var _this = this
    clearTimeout(this.waiting_for_timer)
    if(timeout){
      this.waiting_for_timer = setTimeout(function(){
        if (_this.waiting_for_cb) {
          var tmp_cb = _this.waiting_for_cb
          _this.waiting_for_cb = null
          _this.wait_for_block = false
          _this.waiting_for = null
          _this.receive_buffer = ""
          _this.receive_buffer_raw = Buffer(0)
          tmp_cb(new Error("timeout"),_this.receive_buffer)
        }
      },timeout)
    }
  }

  follow(cb){
    var _this = this
    var data_err,data = ""
    this.logger.verbose("Following up...")
    cb(null,"")
  }



  // <code[binary]>
  exec_raw_no_reset(code,cb){
    this.logger.verbose("Executing code:" +code)
    var data = new Buffer(code,"binary")
    this.send_raw(data,function(err){
      if(cb){
        cb(err)
      }
    })
  }

  // unused code 
  // // delay 50ms, <code[binary]>
  // exec_raw_delayed(code,cb,timeout){
  //   var _this = this
  //   setTimeout(function(){
  //     _this.exec_raw(code,cb,timeout)
  //   },50)
  // }

  // <code[binary]>, soft-reset
  exec_raw(code,cb,timeout){
    var _this = this
    this.exec_raw_no_reset(code,function(){
      _this.logger.silly("Executed raw code, now resetting")
        _this.soft_reset(cb,timeout)
    })
  }
  // CR-LF, <code>, soft-reset 
  exec_(code,cb){
    var _this = this
    this.exec_raw_no_reset("\r\n"+code,function(){
      _this.logger.silly("Executed code, now resetting")
      _this.soft_reset(cb)
    })
  }

  // flush the buffer to the MCU 
  flush(cb){
    if(!this.connection){
      cb(new Error("No connection"))
      return
    }
    this.connection.flush(cb)
  }
  // check if the received text contains one of the known error messages (list of 6)  
  getErrorMessage(text){
    var messages = this.config.error_messages
    for(var key in messages){
      if(text.indexOf(key) > -1) {
        return messages[key]
      }
    }
    return ""
  }

}
