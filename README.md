This is my script to get all of my dotfiles in order on a new server.

First, lets add the vimrc

Run this in home directory

```echo "runtime vimrc" > ~/.vimrc && mkdir ~/.vim && cd ~/.vim && git clone https://github.com/andreylukin/dotfiles.git . && git clone https://github.com/gmarik/Vundle.vim.git ~/.vim/bundle/Vundle.vim && vim +PluginInstall```


I need to thank **joom/vim-starter** for the idea/code because some/most of it is copied from their project. :)


Secondly, to have your zshrc setup, run this in home directory

```sudo apt install zsh && sh -c "$(curl -fsSL https://raw.githubusercontent.com/robbyrussell/oh-my-zsh/master/tools/install.sh)" && chsh -s $(which zsh) && mkdir .andrey-zsh-config && cd .andrey-zsh-config && git clone https://github.com/andreylukin/dotfiles.git . && cp .zshrc ~/ && cd ~/ && source ~/.profile > .bashrc```

Done!
